'use strict';

var q = require('q');
var isCss = require('is-css');
var isHtml = require('is-html');
var isPresent = require('is-present');
var isBlank = require('is-blank');
var isUrl = require('is-url-superb');
var request = require('request');
var cheerio = require('cheerio');
var normalizeUrl = require('normalize-url');
var stripHtmlComments = require('strip-html-comments');
var resolveCssImportUrls = require('resolve-css-import-urls');
var ua = require('ua-string');

var getLinkContents = require('./utils/get-link-contents');
var createLink = require('./utils/create-link');

module.exports = function(url, options){
  var deferred = q.defer();
  var options = options || {};
  options.headers = options.headers || {};
  options.headers['User-Agent'] = options.headers['User-Agent'] || ua;
  options.timeout = options.timeout || 5000;
  options.gzip = true;

  if (typeof url !== 'string' || isBlank(url) || !isUrl(url)) {
    throw new TypeError('get-css expected a url as a string')
  }

  url = normalizeUrl(url, { stripWWW: false });
  options.url = url;

  if (options.ignoreCerts) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  var status = {
    parsed: 0,
    total: 0
  };

  var result = {
    links: [],
    styles: [],
    css: []
  };

  function handleResolve() {
    if (status.parsed >= status.total) {
      const css = [].concat.apply([], result.css);
      result.css = css.join('');
      deferred.resolve(result);
    }
  }

  function parseHtml(html) {
    var $ = cheerio.load(html);
    result.pageTitle = $('head > title').text();

    var toProcess = [];
    $('style, [rel=stylesheet]').each(function() {
      var link = $(this).attr('href');
      if(isPresent(link)) {
        return toProcess.push({
          isLink: true,
          content: createLink(link, url)
        });
      }
      toProcess.push({
        isLink: false,
        content: stripHtmlComments($(this).text())
      });
    });

    status.total = toProcess.length;
    if (!status.total) {
      deferred.resolve(false);
    }

    toProcess.forEach(function(task, index) {
      if (task.isLink) {
        return getLinkContents(task.content.url, options)
          .then(function(css) {
            handleCssFromLink(task.content, css, index);
          })
          .catch(function(error) {
            // link.error = error;
            status.parsed++;
            handleResolve();
          });
      }
      result.css[index] = task.content;
      status.parsed++;
      handleResolve();
    });
  }

  function handleCssFromLink(link, css, index) {
    link.css += css;

    result.css[index] = css;
    // For now, we don't support the @import url follow
    // parseCssForImports(link, css, index);

    status.parsed++;
    handleResolve();
  }

  function setCss(index, css) {
    if (!result.css[index]) {
      result.css[index] = css;
      return;
    }

    if (!Array.isArray(result.css[index])) {
      result.css[index] = [result.css[index]];
    }
    result.css[index].push(css);
  }

  // TODO: Asegurarse de que esto funciona
  // Handle potential @import url(foo.css) statements in the CSS.
  function parseCssForImports(link, css, index) {
    link.imports = resolveCssImportUrls(link.url, css);
    status.total += link.imports.length;
    setCss(index, css);

    link.imports.forEach(function(importUrl) {
      var importLink = createLink(importUrl, importUrl);
      result.links.push(importLink);

      getLinkContents(importLink.url, options)
        .then(function(css) {
          handleCssFromLink(importLink, css, index);
        })
        .catch(function(error) {
          link.error = error;
          status.parsed++;
          handleResolve();
        });
    });
  }

  request(options, function(error, response, body) {
    if (error) {
      if (options.verbose) console.log('Error from ' + url + ' ' + error);
      deferred.reject(error);
      return;
    }

    var validBody = !isCss(url) && isHtml(body);
    if (response && response.statusCode != 200 && !validBody) {
      if (options.verbose) console.log('Received a ' + response.statusCode + ' from: ' + url);
      deferred.reject({ url: url, statusCode: response.code });
      return;
    }

    if (isCss(url)) {
      var link = createLink(url, url);
      result.links.push(link);
      handleCssFromLink(link, body);
    } else {
      parseHtml(body);
    }
  });

  return deferred.promise;
};
