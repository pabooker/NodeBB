'use strict';

var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var winston = require('winston');
var async = require('async');
var path = require('path');
var fs = require('fs');
var nconf = require('nconf');

var plugins = require('../plugins');
var file = require('../file');

var Templates = {};

Templates.compile = function (callback) {
	callback = callback || function () {};

	compile(callback);
};


function getBaseTemplates(theme) {
	var baseTemplatesPaths = [];
	var baseThemePath;
	var baseThemeConfig;

	while (theme) {
		baseThemePath = path.join(nconf.get('themes_path'), theme);
		baseThemeConfig = require(path.join(baseThemePath, 'theme.json'));

		baseTemplatesPaths.push(path.join(baseThemePath, baseThemeConfig.templates || 'templates'));
		theme = baseThemeConfig.baseTheme;
	}

	return baseTemplatesPaths.reverse();
}

function preparePaths(baseTemplatesPaths, callback) {
	var coreTemplatesPath = nconf.get('core_templates_path');
	var viewsPath = nconf.get('views_dir');

	async.waterfall([
		function (next) {
			rimraf(viewsPath, next);
		},
		function (next) {
			mkdirp(viewsPath, next);
		},
		function (viewsPath, next) {
			plugins.fireHook('static:templates.precompile', {}, next);
		},
		function (next) {
			plugins.getTemplates(next);
		},
	], function (err, pluginTemplates) {
		if (err) {
			return callback(err);
		}

		winston.verbose('[meta/templates] Compiling templates');

		async.parallel({
			coreTpls: function (next) {
				file.walk(coreTemplatesPath, next);
			},
			baseThemes: function (next) {
				async.map(baseTemplatesPaths, function (baseTemplatePath, next) {
					file.walk(baseTemplatePath, function (err, paths) {
						paths = paths.map(function (tpl) {
							return {
								base: baseTemplatePath,
								path: tpl.replace(baseTemplatePath, ''),
							};
						});

						next(err, paths);
					});
				}, next);
			},
		}, function (err, data) {
			var baseThemes = data.baseThemes;
			var coreTpls = data.coreTpls;
			var paths = {};

			coreTpls.forEach(function (el, i) {
				paths[coreTpls[i].replace(coreTemplatesPath, '')] = coreTpls[i];
			});

			baseThemes.forEach(function (baseTpls) {
				baseTpls.forEach(function (el, i) {
					paths[baseTpls[i].path] = path.join(baseTpls[i].base, baseTpls[i].path);
				});
			});

			for (var tpl in pluginTemplates) {
				if (pluginTemplates.hasOwnProperty(tpl)) {
					paths[tpl] = pluginTemplates[tpl];
				}
			}

			callback(err, paths);
		});
	});
}

function compile(callback) {
	var themeConfig = require(nconf.get('theme_config'));
	var baseTemplatesPaths = themeConfig.baseTheme ? getBaseTemplates(themeConfig.baseTheme) : [nconf.get('base_templates_path')];
	var viewsPath = nconf.get('views_dir');

	function processImports(paths, relativePath, source, callback) {
		var regex = /<!-- IMPORT (.+?) -->/;

		var matches = source.match(regex);

		if (!matches) {
			return callback(null, source);
		}

		var partial = '/' + matches[1];
		if (paths[partial] && relativePath !== partial) {
			fs.readFile(paths[partial], function (err, file) {
				if (err) {
					return callback(err);
				}

				var partialSource = file.toString();
				source = source.replace(regex, partialSource);

				processImports(paths, relativePath, source, callback);
			});
		} else {
			winston.warn('[meta/templates] Partial not loaded: ' + matches[1]);
			source = source.replace(regex, '');

			processImports(paths, relativePath, source, callback);
		}
	}

	preparePaths(baseTemplatesPaths, function (err, paths) {
		if (err) {
			return callback(err);
		}

		async.each(Object.keys(paths), function (relativePath, next) {
			async.waterfall([
				function (next) {
					fs.readFile(paths[relativePath], next);
				},
				function (file, next) {
					var source = file.toString();
					processImports(paths, relativePath, source, next);
				},
				function (compiled, next) {
					mkdirp(path.join(viewsPath, path.dirname(relativePath)), function (err) {
						next(err, compiled);
					});
				},
				function (compiled, next) {
					fs.writeFile(path.join(viewsPath, relativePath), compiled, next);
				},
			], next);
		}, function (err) {
			if (err) {
				winston.error('[meta/templates] ' + err.stack);
				return callback(err);
			}

			winston.verbose('[meta/templates] Successfully compiled templates.');

			callback();
		});
	});
}

module.exports = Templates;
