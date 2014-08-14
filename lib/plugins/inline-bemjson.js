var path = require('path');
var crypto = require('crypto');
var vm = require('vm');
var naming = require('bem-naming');
var vow = require('vow');
var vfs = require('enb/lib/fs/async-fs');
var scanner = require('enb-bem-pseudo-levels/lib/level-scanner');
var BEMJSON_CODE_REGEX = /`{3,}bemjson\n([^`]*)\n`{3,}/gi;

/**
 * Возвращает конфигуратор уровня-сетов из примеров БЭМ-блоков с помощью `MagicHelper`.
 * Умеет собирать примеры по md-файлам.
 *
 * @param {MagicHelper} helper
 * @returns {{configure: Function}}
 */
module.exports = function (helper) {
    return {
        /**
         * Настраивает сборку примеров по md-файлам, обрабатывая полученный `bemjson` с помощью `processInlineBemjson`
         * функции. На файловую систему пример запишется с именем равным хэш-сумме от исходного кода примера.
         *
         * Инлайновый пример в md-файле может выглядеть следующим образом:
         *
         * ```bemjson
         * ({
         *     block: 'button',
         *     text: 'Click me!'
         * })
         * ```
         *
         * @param {Object}   options
         * @param {String}   options.destPath               Путь до нового уровня-сета относительный корня.
         * @param {Array}    options.levels                 Уровни в которых следует искать примеры.
         * @param {Function} [options.processInlineBemjson] Функция обработки инлайнового bemjson.
         */
        configure: function (options) {
            var config = helper.getProjectConfig();
            var channel = helper.getEventChannel();
            var root = config.getRootPath();

            helper.prebuild(function (buildConfig) {
                return getMdFiles(options.levels)
                    .then(function (filenames) {
                        return getExamplesFromMdFiles(filenames, options.destPath);
                    })
                    .then(function (examples) {
                        // Отсеиваем примеры, которые не нужно собирать
                        examples = examples.filter(function (example) {
                            return buildConfig.isRequiredNode(example.path);
                        });

                        return vow.all(examples.map(function (example) {
                            var dirname = path.join(root, example.path);
                            var target = path.join(example.path, example.name + '.bemjson.js');
                            var bemjsonFilename = path.join(root, target);
                            var bemjson = buildBemjson(example, bemjsonFilename, options.processInlineBemjson);

                            // Записываем bemjson на файловую систему
                            return vfs.makeDir(dirname)
                                .then(function () {
                                    return vfs.write(bemjsonFilename, bemjson, 'utf-8');
                                })
                                .then(function () {
                                    buildConfig.registerTarget(target);

                                    return example;
                                });
                        }));
                    })
                    .then(function (examples) {
                        // Сообщаем о созданных примерах
                        channel.emit('inline-examples', options.destPath, examples);
                    });
            });
        }
    };
};

function buildBemjson(example, bemjsonFilename, callback) {
    var bemjson = vm.runInNewContext('(' + example.source + ')', {});
    var meta = {
        filename: bemjsonFilename,
        notation: example.notation
    };

    return '(' + JSON.stringify(callback(bemjson, meta)) + ')';
}

function getExamplesFromMdFiles(filenames, dstpath) {
    return vow.all(filenames.map(function (filename) {
            return getExamplesFromMdFile(filename, dstpath);
        }))
        .then(function (list) {
            return Array.prototype.concat.apply([], list);
        });
}

function getMdFiles(levels) {
    return scanner.scan(levels)
        .then(function (files) {
            var filenames = [];

            files.forEach(function (file) {
                var ext = path.extname(file.fullname);

                if (ext === '.md') {
                    filenames.push(file.fullname);
                }
            });

            return filenames;
        });
}

function getExamplesFromMdFile(filename, dstpath) {
    return vfs.read(filename, 'utf-8')
        .then(function (source) {
            var basename = path.basename(filename);
            var examples = getExamplesFromSource(source);
            var notation = naming.parse(basename.split('.')[0]);
            var scope = path.join(dstpath, notation.block);

            return examples.map(function (example) {
                example.path = path.join(scope, example.name);
                example.notation = notation;

                return example;
            });
        });
}

function getExamplesFromSource(source) {
    var matched = source.match(BEMJSON_CODE_REGEX);

    return matched ? matched.map(function (str) {
        var code = str.split('\n').slice(1);

        code.pop();
        code = code.join('\n');

        var shasum = crypto.createHash('sha1'); shasum.update(code);
        var base64 = fixBase64(shasum.digest('base64'));

        return {
            name: base64,
            source: code
        };
    }) : [];
}

function fixBase64(base64) {
    return base64
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '')
        .replace(/^[+-]+/g, '');
}