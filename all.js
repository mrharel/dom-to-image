(function (global) {
  'use strict';

  var util = newUtil();
  var inliner = newInliner();
  var fontFaces = newFontFaces();
  var images = newImages();
  var defaultGroupName = "__defult-group-name__";
  var modifierGroups = {};
  var errorHandlers = [];


  global.domtoimage = {
    toSvg: toSvg,
    toPng: toPng,
    toBlob: toBlob,
    registerModifier: registerModifier,
    registerErrorHandler: registerErrorHandler,
    impl: {
      fontFaces: fontFaces,
      images: images,
      util: util,
      inliner: inliner
    }
  };

  function registerErrorHandler(handler){
    errorHandlers.push(handler);
  };


  /**
   *
   * @param type {String} "clone" or "style", "error"
   * @param modifier {Object} the modifier object
   * @param filters {Object}
   * @param priority {number} if two modifiers will be used on the same element the one with the highest priority will win
   * @param groupName {String} register the modifier to a group name. if not set it wll be set to the default name.
   */
  function registerModifier(type,modifier,filters,priority,groupName){
    filters = filters || {};
    groupName = groupName || defaultGroupName;
    priority = priority || 0;
    if( type !== 'clone' && type !== 'style'&& type !== 'error' ){
      throw new Error("Unknown modifier type " + type);
    }
    if( !modifierGroups[groupName] ){
      modifierGroups[groupName] = {
        clone : [],
        style : []
      };
    }
    var modifiers = modifierGroups[groupName];
    modifiers[type].push({
      modifier: modifier,
      filters: filters,
      priority: priority
    });
  }

  function getModifiers(type,node,groupName){
    var arr = [];
    groupName = groupName || defaultGroupName;
    var modifiers = modifierGroups[groupName] || [];

    for( var i=0 ; i<modifiers[type].length ; i++ ){
      var modifierObj = modifiers[type][i];
      if( !Object.keys(modifierObj.filters).length ){
        arr.push(modifierObj);
      }
      else if( modifierObj.filters.check ){
        if( modifierObj.filters.check(node) ){
          arr.push(modifierObj);
        }
      }
      else if(modifierObj.filters.isSelector ){
        if( $(node).is(modifierObj.filters.isSelector) ){
          arr.push(modifierObj);
        }
      }
    }

    return arr;
  };

  /**
   * @param {Node} node - The DOM Node object to render
   * @param {Object} options - Rendering options
   * @param {Function} options.filter - Should return true if passed node should be included in the output
   *          (excluding node means excluding it's children as well)
   * @param {String} options.bgcolor - color for the background, any valid CSS color value
   * @param {String} options.group - the group name for the modifiers.
   * @return {Promise} - A promise that is fulfilled with a SVG image data URL
   * */
  function toSvg(node, options) {
    options = options || {};
    return Promise.resolve(node)
        .then(function (node) {
          return cloneNode(node, options.filter,options.group,true);
        })
        .then(embedFonts)
        .then(inlineImages)
        .then(function (clone) {
          if (options.bgcolor) clone.style.backgroundColor = options.bgcolor;
          return clone;
        })
        .then(function (clone) {
          var width = util.nodeWidth(node);
          var height = util.nodeHeight(node);
          return makeSvgDataUri(clone, width,height);
        });
  }

  /**
   * @param {Node} node - The DOM Node object to render
   * @param {Object} options - Rendering options, @see {@link toSvg}
   * @return {Promise} - A promise that is fulfilled with a PNG image data URL
   * */
  function toPng(node, options) {
    return draw(node, options || {})
        .then(function (canvas) {
          return canvas.toDataURL();
        });
  }

  /**
   * @param {Node} node - The DOM Node object to render
   * @param {Object} options - Rendering options, @see {@link toSvg}
   * @return {Promise} - A promise that is fulfilled with a PNG image blob
   * */
  function toBlob(node, options) {
    return draw(node, options || {})
        .then(util.canvasToBlob);
  }

  function cloneNode(node, filter,groupName,isRoot) {
    if (filter && !filter(node)) return Promise.resolve();

    groupName = groupName || defaultGroupName;
    return Promise.resolve(node)
        .then(function (node) {
          var modArr = getModifiers("clone",node,groupName);
          if( !modArr.length ) return util.cloneNode(node,isRoot);//node.cloneNode(false);
          var arr = [];
          for( var i=0; i<modArr.length ; i++ ){
            arr.push( modArr[i].modifier({node:node}));
          }
          return Promise.all(arr)
              .then( function(results){
                var candidates = [];
                for( var i=0; i<results.length; i++ ){
                  if( results[i] !== node ){
                    candidates.push({priority:modArr[i].priority,node:results[i]});
                  }
                }
                if( candidates.length ){
                  candidates.sort( function(a,b){
                    return b.priority - a.priority;
                  });
                  if( candidates[0].node ){
                    candidates[0].node.__modifierClone = true;
                    return candidates[0].node;
                  }
                  //modifier told us to ignore this element.
                  return Promise.resolve();
                }
                return util.cloneNode(node,isRoot);//node.cloneNode(false);
              },function(){
                return util.cloneNode(node,isRoot);//node.cloneNode(false);
              });
        })
        .then(function (clone) {
          if( !clone ) return Promise.resolve();
          return cloneChildren(node, clone, filter,groupName);
        })
        .then(function (clone) {
          if( !clone ) return Promise.resolve();
          return processClone(node, clone,isRoot);
        });

    function cloneChildren(original, clone, filter,groupName) {
      var children = original.childNodes;
      if (children.length === 0) return Promise.resolve(clone);

      return cloneChildrenInOrder(clone, util.asArray(children), filter,groupName)
          .then(function () {
            return clone;
          });

      function cloneChildrenInOrder(parent, children, filter,groupName) {
        var done = Promise.resolve();
        children.forEach(function (child) {
          done = done
              .then(function () {
                return cloneNode(child, filter,groupName);
              })
              .then(function (childClone) {
                if (childClone) parent.appendChild(childClone);
              });
        });
        return done;
      }
    }

    function processClone(original, clone,isRoot) {
      if (!(clone instanceof Element)) return clone;

      return Promise.resolve()
          .then(cloneStyle)
          .then(clonePseudoElements)
          .then(copyUserInput)
          .then(fixNamespace)
          .then(function () {
            return clone;
          });

      function cloneStyle() {
        if( clone.__modifierClone ) return;
        copyStyle(global.window.getComputedStyle(original), clone.style);
        if( original.tagName === 'BODY' ){
          //TODO replace jquery with raw js code
          $(clone).css("height",original.scrollHeight);
        }

        function copyStyle(source, target) {
          if (source.cssText){
            target.cssText = source.cssText;
          }
          else{
            copyProperties(source, target);
          }

          function copyProperties(source, target) {
            util.asArray(source).forEach(function (name) {
              target.setProperty(
                  name,
                  source.getPropertyValue(name),
                  source.getPropertyPriority(name)
              );
            });
          }
        }
      }

      function clonePseudoElements() {
        if( clone.__modifierClone ) return;

        [':before', ':after'].forEach(function (element) {
          clonePseudoElement(element);
        });

        function clonePseudoElement(element) {
          var style = global.window.getComputedStyle(original, element);
          var content = style.getPropertyValue('content');

          if (content === '' || content === 'none') return;

          var className = util.uid();
          clone.className = clone.className + ' ' + className;
          var styleElement = global.document.createElement('style');
          styleElement.appendChild(formatPseudoElementStyle(className, element, style));
          clone.appendChild(styleElement);

          function formatPseudoElementStyle(className, element, style) {
            var selector = '.' + className + ':' + element;
            var cssText = style.cssText ? formatCssText(style) : formatCssProperties(style);
            return global.document.createTextNode(selector + '{' + cssText + '}');

            function formatCssText(style) {
              var content = style.getPropertyValue('content');
              return style.cssText + ' content: ' + content + ';';
            }

            function formatCssProperties(style) {

              return util.asArray(style)
                      .map(formatProperty)
                      .join('; ') + ';';

              function formatProperty(name) {
                return name + ': ' +
                    style.getPropertyValue(name) +
                    (style.getPropertyPriority(name) ? ' !important' : '');
              }
            }
          }
        }
      }

      function copyUserInput() {
        if( clone.__modifierClone ) return;
        if (original instanceof HTMLTextAreaElement) clone.innerHTML = original.value;
        if( original instanceof HTMLInputElement ) clone.setAttribute("value",original.value);

      }

      function fixNamespace() {
        if (clone instanceof SVGElement) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      }
    }
  }

  function embedFonts(node) {
    return fontFaces.resolveAll()
        .then(function (cssText) {
          var styleNode = document.createElement('style');
          node.appendChild(styleNode);
          styleNode.appendChild(document.createTextNode(cssText));
          return node;
        });
  }

  function inlineImages(node) {
    return images.inlineAll(node)
        .then(function () {
          return node;
        });
  }

  function makeSvgDataUri(node, width, height) {
    //root node should not be with margin.
    node.style.marginBottom = 0;
    node.style.marginTop = 0;
    node.style.marginLeft = 0;
    node.style.marginRight = 0;


    return Promise.resolve(node)
        .then(function (node) {
          node.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
          var xml =  new XMLSerializer().serializeToString(node);
          //console.log("*** XML START ***");
          //console.log(xml);
          //console.log("*** XML END ***");
          return xml;
        })
        .then(util.escapeXhtml)
        .then(function (xhtml) {
          return '<foreignObject x="0" y="0" width="100%" height="100%">' + xhtml + '</foreignObject>';
        })
        .then(function (foreignObject) {
          return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '">' + foreignObject + '</svg>';
        })
        .then(function (svg) {
          return 'data:image/svg+xml;charset=utf-8,' + svg;
        });
  }

  function draw(domNode, options) {
    return toSvg(domNode, options)
        .then(util.makeImage)
        .then(util.delay(100))
        .then(function (image) {
          var canvas = newCanvas(domNode);
          canvas.getContext('2d').drawImage(image, 0, 0);
          return canvas;
        });

    function newCanvas(domNode) {
      var canvas = document.createElement('canvas');
      canvas.width = util.nodeWidth(domNode);//domNode.scrollWidth;
      canvas.height = util.nodeHeight(domNode);//domNode.scrollHeight;
      return canvas;
    }
  }

  function newUtil() {
    return {
      escape: escape,
      parseExtension: parseExtension,
      mimeType: mimeType,
      dataAsUrl: dataAsUrl,
      isDataUrl: isDataUrl,
      canvasToBlob: canvasToBlob,
      resolveUrl: resolveUrl,
      getAndEncode: getAndEncode,
      uid: uid(),
      delay: delay,
      asArray: asArray,
      escapeXhtml: escapeXhtml,
      makeImage: makeImage,
      nodeWidth: nodeWidth,
      nodeHeight: nodeHeight,
      cloneNode: cloneNode,
      removeAllAttributes: removeAllAttributes
    };

    function cloneNode(node,isRoot){
      if( node.nodeType == 8 ){
        return null;
      }
      var clone = node.cloneNode(false);
      util.removeAllAttributes(clone);

      return clone;
    }

    function removeAllAttributes(node){
      if( !node || !node.attributes ) return;
      var attr = [];
      for( var i=0; i<node.attributes.length; i++ ){
        attr.push(node.attributes[i].name);
      }

      attr.forEach(function(val){
        switch(val.toLowerCase()){
          case "src":
          case "href":
          case "id":
          case "width":
          case "height":
            return;
        }
        node.removeAttribute(val);
      });
    }

    function nodeWidth(node,withMargin){
      var width = node.scrollWidth;
      var styles = getComputedStyle(node);

      //adding border
      var borderLeft = styles.getPropertyValue("border-left");
      if( borderLeft && /^[\d]+/.test(borderLeft)){
        borderLeft = +borderLeft.match(/^[\d]+/)[0];
      }
      else{
        borderLeft = 0;
      }

      var borderRight = styles.getPropertyValue("border-right");
      if( borderRight && /^[\d]+/.test(borderRight)){
        borderRight = +borderRight.match(/^[\d]+/)[0];
      }
      else{
        borderRight = 0;
      }

      //adding margin
      var marginLeft = styles.getPropertyValue("margin-left");
      if( withMargin && marginLeft && /^[\d]+/.test(marginLeft)){
        marginLeft = +marginLeft.match(/^[\d]+/)[0];
      }
      else{
        marginLeft = 0;
      }


      var marginRight = styles.getPropertyValue("margin-right");
      if( withMargin && marginRight && /^[\d]+/.test(marginRight)){
        marginRight = +marginRight.match(/^[\d]+/)[0];
      }
      else{
        marginRight = 0;
      }

      return width + borderLeft + borderRight + marginLeft + marginRight;
    };

    function nodeHeight(node,withMargin){
      var height = node.scrollHeight;
      var styles = getComputedStyle(node);

      //adding border
      var borderTop = styles.getPropertyValue("border-top");
      if( borderTop && /^[\d]+/.test(borderTop)){
        borderTop = +borderTop.match(/^[\d]+/)[0];
      }
      else{
        borderTop = 0;
      }

      var borderBottom = styles.getPropertyValue("border-bottom");
      if( borderBottom && /^[\d]+/.test(borderBottom)){
        borderBottom = +borderBottom.match(/^[\d]+/)[0];
      }
      else{
        borderBottom = 0;
      }

      //adding margin
      var marginTop = styles.getPropertyValue("margin-top");
      if( withMargin && marginTop && /^[\d]+/.test(marginTop)){
        marginTop = +marginTop.match(/^[\d]+/)[0];
      }
      else{
        marginTop = 0;
      }


      var marginBottom = styles.getPropertyValue("margin-bottom");
      if( withMargin && marginBottom && /^[\d]+/.test(marginBottom)){
        marginBottom = +marginBottom.match(/^[\d]+/)[0];
      }
      else{
        marginBottom = 0;
      }

      return height + borderTop + borderBottom + marginTop + marginBottom;
    }

    function mimes() {
      /*
       * Only WOFF and EOT mime types for fonts are 'real'
       * see http://www.iana.org/assignments/media-types/media-types.xhtml
       */
      const WOFF = 'application/font-woff';
      const JPEG = 'image/jpeg';

      return {
        'woff': WOFF,
        'woff2': WOFF,
        'ttf': 'application/font-truetype',
        'eot': 'application/vnd.ms-fontobject',
        'png': 'image/png',
        'jpg': JPEG,
        'jpeg': JPEG,
        'gif': 'image/gif',
        'tiff': 'image/tiff',
        'svg': 'image/svg+xml'
      };
    }

    function parseExtension(url) {
      var match = /\.([^\.\/]*?)$/g.exec(url);
      if (match) return match[1];
      else return '';
    }

    function mimeType(url) {
      var extension = parseExtension(url).toLowerCase();
      return mimes()[extension] || '';
    }

    function isDataUrl(url) {
      return url.search(/^(data:)/) !== -1;
    }

    function toBlob(canvas) {
      return new Promise(function (resolve) {
        var binaryString = window.atob(canvas.toDataURL().split(',')[1]);
        var length = binaryString.length;
        var binaryArray = new Uint8Array(length);

        for (var i = 0; i < length; i++)
          binaryArray[i] = binaryString.charCodeAt(i);

        resolve(new Blob([binaryArray], {
          type: 'image/png'
        }));
      });
    }

    function canvasToBlob(canvas) {
      if (canvas.toBlob)
        return new Promise(function (resolve) {
          canvas.toBlob(resolve);
        });

      return toBlob(canvas);
    }

    function resolveUrl(url, baseUrl) {
      var doc = global.document.implementation.createHTMLDocument();
      var base = doc.createElement('base');
      doc.head.appendChild(base);
      var a = doc.createElement('a');
      doc.body.appendChild(a);
      base.href = baseUrl;
      a.href = url;
      return a.href;
    }

    function uid() {
      var index = 0;

      return function () {
        return 'u' + fourRandomChars() + index++;

        function fourRandomChars() {
          /* see http://stackoverflow.com/a/6248722/2519373 */
          return ('0000' + (Math.random() * Math.pow(36, 4) << 0).toString(36)).slice(-4);
        }
      };
    }

    function makeImage(uri) {
      return new Promise(function (resolve, reject) {
        var image = new Image();
        image.onload = function () {
          resolve(image);
        };
        image.onerror = function(){
          console.log("failed to generate image from svg");
          reject();

          var modArr = errorHandlers;
          if( !modArr.length ){
            return;
          }
          var arr = [];
          for( var i=0; i<modArr.length ; i++ ){
            arr.push( modArr[i]({type:"svg2img",uri:uri}));
          }
          return Promise.all(arr)
              .then( function(results){});
        };
        console.log("loading image from svg  ");
        image.src = uri;
      });
    }

    function getAndEncode(url) {
      const TIMEOUT = 30000;

      return new Promise(function (resolve, reject) {
        var request = new XMLHttpRequest();

        request.onreadystatechange = done;
        request.ontimeout = timeout;
        request.responseType = 'blob';
        request.timeout = TIMEOUT;
        request.open('GET', url, true);
        request.send();

        function done() {
          if (request.readyState !== 4) return;

          if (request.status !== 200) {
            //reject(new Error('Cannot fetch resource ' + url + ', status: ' + request.status));
            onError(request,url,resolve,reject);
            return;
          }

          var encoder = new FileReader();
          encoder.onloadend = function () {
            var content = encoder.result.split(/,/)[1];
            resolve(content);
          };
          encoder.readAsDataURL(request.response);
        }

        function timeout() {
          reject(new Error('Timeout of ' + TIMEOUT + 'ms occured while fetching resource: ' + url));
        }
      });

      function onError(request,url,resolve,reject){
        var modArr = errorHandlers;
        if( !modArr.length ){
          reject(new Error('Cannot fetch resource ' + url + ', status: ' + request.status));
          return;
        }
        var arr = [];
        for( var i=0; i<modArr.length ; i++ ){
          arr.push( modArr[i]({url:url,type:"network"}));
        }
        return Promise.all(arr)
            .then( function(results){

              for( var i=0; i<results.length; i++ ){
                if(  results[i]  ){
                  resolve(results[i]);
                  return;
                }
              }
              reject(new Error('Cannot fetch resource ' + url + ', status: ' + request.status));

            },function(){
              reject(new Error('Cannot fetch resource ' + url + ', status: ' + request.status));
            });
      }
    }

    function dataAsUrl(content, type) {
      return 'data:' + type + ';base64,' + content;
    }

    function escape(string) {
      return string.replace(/([.*+?^${}()|\[\]\/\\])/g, '\\$1');
    }

    function delay(ms) {
      return function (arg) {
        return new Promise(function (resolve) {
          setTimeout(function () {
            resolve(arg);
          }, ms);
        });
      };
    }

    function asArray(arrayLike) {
      var array = [];
      var length = arrayLike.length;
      for (var i = 0; i < length; i++) array.push(arrayLike[i]);
      return array;
    }

    function escapeXhtml(string) {
      return string.replace(/#/g, '%23').replace(/\n/g, '%0A');
    }
  }

  function newInliner() {
    const URL_REGEX = /url\(['"]?([^'"]+?)['"]?\)/g;

    return {
      inlineAll: inlineAll,
      shouldProcess: shouldProcess,
      impl: {
        readUrls: readUrls,
        inline: inline
      }
    };

    function shouldProcess(string) {
      return string.search(URL_REGEX) !== -1;
    }

    function readUrls(string) {
      var result = [];
      var match;
      while ((match = URL_REGEX.exec(string)) !== null) {
        result.push(match[1]);
      }
      return result.filter(function (url) {
        return !util.isDataUrl(url);
      });
    }

    function inline(string, url, baseUrl, get) {
      return Promise.resolve(url)
          .then(function (url) {
            return baseUrl ? util.resolveUrl(url, baseUrl) : url;
          })
          .then(get || util.getAndEncode)
          .then(function (data) {
            return util.dataAsUrl(data, util.mimeType(url));
          })
          .then(function (dataUrl) {
            return string.replace(urlAsRegex(url), '$1' + dataUrl + '$3');
          });

      function urlAsRegex(url) {
        return new RegExp('(url\\([\'"]?)(' + util.escape(url) + ')([\'"]?\\))', 'g');
      }
    }

    function inlineAll(string, baseUrl, get) {
      if (nothingToInline()) return Promise.resolve(string);

      return Promise.resolve(string)
          .then(readUrls)
          .then(function (urls) {
            var done = Promise.resolve(string);
            urls.forEach(function (url) {
              done = done.then(function (string) {
                return inline(string, url, baseUrl, get);
              });
            });
            return done;
          });

      function nothingToInline() {
        return !shouldProcess(string);
      }
    }
  }

  function newFontFaces() {
    return {
      resolveAll: resolveAll,
      impl: {
        readAll: readAll
      }
    };

    function resolveAll() {
      return readAll(document)
          .then(function (webFonts) {
            return Promise.all(
                webFonts.map(function (webFont) {
                  return webFont.resolve();
                })
            );
          })
          .then(function (cssStrings) {
            return cssStrings.join('\n');
          });
    }

    function readAll() {
      return Promise.resolve(util.asArray(document.styleSheets))
          .then(getCssRules)
          .then(selectWebFontRules)
          .then(function (rules) {
            return rules.map(newWebFont);
          });

      function selectWebFontRules(cssRules) {
        return cssRules
            .filter(function (rule) {
              return rule.type === CSSRule.FONT_FACE_RULE;
            })
            .filter(function (rule) {
              return inliner.shouldProcess(rule.style.getPropertyValue('src'));
            });
      }

      function getCssRules(styleSheets) {
        var cssRules = [];
        styleSheets.forEach(function (sheet) {
          try {
            util.asArray(sheet.cssRules || []).forEach(cssRules.push.bind(cssRules));
          } catch (e) {
            console.log('Error while reading CSS rules from ' + sheet.href, e.toString());
          }
        });
        return cssRules;
      }

      function newWebFont(webFontRule) {
        return {
          resolve: function resolve() {
            var baseUrl = (webFontRule.parentStyleSheet || {}).href;
            return inliner.inlineAll(webFontRule.cssText, baseUrl);
          },
          src: function () {
            return webFontRule.style.getPropertyValue('src');
          }
        };
      }
    }
  }

  function newImages() {
    return {
      inlineAll: inlineAll,
      impl: {
        newImage: newImage
      }
    };

    function newImage(element) {
      return {
        inline: inline
      };

      function inline(get) {
        if (util.isDataUrl(element.src)) return Promise.resolve();

        return Promise.resolve(element.src)
            .then(get || util.getAndEncode)
            //this doesnt work since once we set crossOrigin to the image the browser
            //return error when we try to load image outside the origin that doesnt' have allow-origin in the header.
            //.then( function(url){
            //    return new Promise( function(resolve,reject){
            //
            //        var img = new Image();
            //        img.crossOrigin = "Anonymous";
            //
            //        img.onload = function(){
            //            var canvas = document.createElement("canvas");
            //            var canvas = document.createElement("canvas");
            //            canvas.width = img.width;
            //            canvas.height = img.height;
            //
            //            // Copy the image contents to the canvas
            //            var ctx = canvas.getContext("2d");
            //            ctx.drawImage(img, 0, 0);
            //
            //            // Get the data-URL formatted image
            //            // Firefox supports PNG and JPEG. You could check img.src to
            //            // guess the original format, but be aware the using "image/jpg"
            //            // will re-encode the image.
            //            var dataURL = canvas.toDataURL("image/png");
            //
            //            dataURL =  dataURL.replace(/^data:image\/(png|jpg);base64,/, "");
            //            resolve(dataURL);
            //        };
            //        img.onerror = function(err,a,b){
            //
            //        }
            //        img.src = url;
            //    });
            //
            //})
            .then(function (data) {
              return util.dataAsUrl(data, util.mimeType(element.src));
            })
            .then(function (dataUrl) {
              return new Promise(function (resolve, reject) {
                element.onload = resolve;
                element.onerror = function(){
                  console.log("failed to load image from data url");
                  reject();
                }
                element.src = dataUrl;
              });
            });
      }
    }

    function inlineAll(node) {
      if (!(node instanceof Element)) return Promise.resolve(node);

      return inlineBackground(node)
          .then(function () {
            if (node instanceof HTMLImageElement)
              return newImage(node).inline();
            else
              return Promise.all(
                  util.asArray(node.childNodes).map(function (child) {
                    return inlineAll(child);
                  })
              );
          });

      function inlineBackground(node) {
        var background = node.style.getPropertyValue('background');

        if (!background) return Promise.resolve(node);

        return inliner.inlineAll(background)
            .then(function (inlined) {
              node.style.setProperty(
                  'background',
                  inlined,
                  node.style.getPropertyPriority('background')
              );
            })
            .then(function () {
              return node;
            });
      }
    }
  }
})(this);

(function(global){
  'use strict';


  function errorSvg(uri){

  }

  global.ErrorHandler = function(data){

    var type = data.type;
    var url = data.url;

    if( type !== "network" && type != 'svg2img') {
      return Promise.resolve(null);
    }


    if( type === 'svg2img' ) return errorSvg(data.uri);

    return new Promise(function(resolve,reject){
      resolve("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");
    });

  };


})(this);

(function(global){
  'use strict';

  global.ModifierCleaner = function(data){

    var node = data.node;
    return new Promise(function(resolve,reject){
      if( node.nodeType == 8 ){
        resolve();
        return;
      }
      var display = $(node).css("display");
      if( display === "none"){
        resolve();
        return;
      }
      switch( node.tagName ){
        case 'SCRIPT':
        case 'STYLE':
        case 'LINK':
        case 'NOSCRIPT':
        case 'AUDIO':
        case 'BASE':
        case 'META':
        case 'NOFRAMES':
        case 'OBJECT':

        //case 'IMG':
        case 'P':
        //case 'A':
        //case 'SPAN':
        //case 'TABLE':
          resolve();
          return;

        case 'IMG':
          var src = $(node).attr("src");
          if( src.length < 5 ){
            var $div = $('<div></div>');
            $div.css({
              width: $(node).outerWidth(),
              height: $(node).outerHeight(),
              background: "#000",
              display: "inline-block"
            });
            resolve($div.get(0));
            return;

          }

      }
      if( /^FB:/.test(node.tagName) ){
        var $div = $('<div></div>');
        $div.css({
          width: $(node).outerWidth(),
          height: $(node).outerHeight(),
          display: $(node).css("display")
        });
        resolve($div.get(0));
        return;
      }
      resolve(node);
    });

  };


})(this);

(function(global){
  'use strict';

  global.ModifierCloneIframe = function(data){

    var node = data.node;
    return new Promise(function(resolve,reject){
      if( node.tagName === 'IFRAME' ) {
        var clone = $('<div>this is an iframe</div>');
        clone.css({
          width: $(node).outerWidth(),
          height: $(node).outerHeight(),
          background: "#e0e0e0",
          border: "1px dashed red"
        });

        resolve(clone.get(0));
      }
      else{
        resolve(node);
      }
    });

  };

  global.ModifierCloneYouTube = function(data){

    var node = data.node;
    return new Promise(function(resolve,reject){
      if( node.tagName === 'IFRAME'  ) {
        var src = $(node).attr("src");
        var youtubeId = src.match(/youtube\.com\/embed\/([a-zA-Z0-9\-_]+)/);
        if( youtubeId && youtubeId[1] ){
          var $img = $('<img/>');
          $img.css({
            width: $(node).outerWidth(),
            height: $(node).outerHeight()
          });
          //$img.attr("src","http://img.youtube.com/vi/"+youtubeId[1]+"/0.jpg");
          $img.attr("src","data:image/jpeg;base64,/9j/4QAYRXhpZgAASUkqAAgAAAAAAAAAAAAAAP/sABFEdWNreQABAAQAAABQAAD/4QOBaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLwA8P3hwYWNrZXQgYmVnaW49Iu+7vyIgaWQ9Ilc1TTBNcENlaGlIenJlU3pOVGN6a2M5ZCI/PiA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJBZG9iZSBYTVAgQ29yZSA1LjUtYzAyMSA3OS4xNTU3NzIsIDIwMTQvMDEvMTMtMTk6NDQ6MDAgICAgICAgICI+IDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+IDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIiB4bWxuczpzdFJlZj0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlUmVmIyIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bXBNTTpPcmlnaW5hbERvY3VtZW50SUQ9InhtcC5kaWQ6NTA5MWRiNDYtMmI3YS00NzlhLWIyMDEtYWM3OTVkMjUyOTViIiB4bXBNTTpEb2N1bWVudElEPSJ4bXAuZGlkOjM5MDg0QTc5MTFGMzExRTQ5Mzg3OTZBRUQ5QjI5MDBDIiB4bXBNTTpJbnN0YW5jZUlEPSJ4bXAuaWlkOjM5MDg0QTc4MTFGMzExRTQ5Mzg3OTZBRUQ5QjI5MDBDIiB4bXA6Q3JlYXRvclRvb2w9IkFkb2JlIFBob3Rvc2hvcCBDQyAyMDE0IChNYWNpbnRvc2gpIj4gPHhtcE1NOkRlcml2ZWRGcm9tIHN0UmVmOmluc3RhbmNlSUQ9InhtcC5paWQ6NTA5MWRiNDYtMmI3YS00NzlhLWIyMDEtYWM3OTVkMjUyOTViIiBzdFJlZjpkb2N1bWVudElEPSJ4bXAuZGlkOjUwOTFkYjQ2LTJiN2EtNDc5YS1iMjAxLWFjNzk1ZDI1Mjk1YiIvPiA8L3JkZjpEZXNjcmlwdGlvbj4gPC9yZGY6UkRGPiA8L3g6eG1wbWV0YT4gPD94cGFja2V0IGVuZD0iciI/Pv/uAA5BZG9iZQBkwAAAAAH/2wCEAAICAgICAgICAgIDAgICAwQDAgIDBAUEBAQEBAUGBQUFBQUFBgYHBwgHBwYJCQoKCQkMDAwMDAwMDAwMDAwMDAwBAwMDBQQFCQYGCQ0LCQsNDw4ODg4PDwwMDAwMDw8MDAwMDAwPDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDP/AABEIBDgHgAMBEQACEQEDEQH/xADTAAEAAQQDAQEAAAAAAAAAAAAAAQQFCAkCAwcGCgEBAAEFAQEAAAAAAAAAAAAAAAECAwQFBgcIEAEAAgECBAMDBwYJCAgDCQAAARECAwQSBQYHUWEIITETQXGxIjIUCYGRwVIzdqFCcpKyI7MVOGLCU3OTNBY30YKio9QmFxhjRlbwgySktGWVZigRAQACAQIBBQsJBgQEBwEBAAABEQIDBAUhMRIGB0FRYXGBkaHB0VITsSIyQpJzNBU14XKC0lMUYqIjFvDiQxeywjNjo0RUJJP/2gAMAwEAAhEDEQA/APDHkj73AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQlSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAixNFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUhIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHEQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4pSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEWmgsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKCygsoLKHFIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLHEQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEWJLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsHG0llhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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fWTtF4jxe9PCfg6M/Vxn52Uf4sufyRUd+2WkzM+2ZbVwFIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABjx6sNf7v6eO5+d18TluOl/tNXHH9LB4nNbbPxOr6j49LjW2/e9TQftIrDH5ocFk+t9HmVyhkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIsLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLUe59uMxE+2VeLH1Z5G9j0abj716b+3ed38PHfaN/wCr3erj+h3XCpvbY+X5Xyf2g4dHjmv/AAz58YZPNi40AAAAAAAAAAAAAAAAAAAAAAAAAAAABhd6+f8AD3uf3j5X9Oo1PG/w3lh6H2XfrWP3efqaXdCZqPY4rJ9QaU8iptQv2WFlhZYW4zlEe+U0pnKnoPbjtT3C7t80nlfQXTu45tGlnGO+5rlE6ex2t/Lr7jL6mPs9vDF5T8kMrbbPV3E1hF/I0PHOsmx4Pp9PdakY97Hnyy8WPP5ebwtoXZ30N9D9Gzteddxtxj131Fp8Opjy6pw5Xt849tRpz9bVmJ+XL2eTp9nwTT0uXU+dPoeEdZO1Le7+9PZx8HT7/wBefL3PJ52ce22+32e30dns9vpbPabfGMNvtdDDHT08MY90Y4YxERHzN3EREVDy7PPLPKcspmZnnmeWXclSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAxe9Z2v939N3cLO6+J/d+l/tN5pY/pa7i01tsvJ8rs+z3Hpcc0P4p/yy0V7b7MRXyOFyfV+lzKu1DIssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywssLLCywtCEAAAAAAAAAAAAAAAAAAAAAAAAA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HFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAHFAOKQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAUAUFIoKKCk0FIqAoqAoqAo4YCio99BRUBRwx+f3iKOGPATRwwIo4Y8BNFQFFQFFQFFQFFQFFQFFBRUBSaCigoCigooKKCgAASAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAixFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHBKbAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsCwLAsC0CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEJQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCiwosKLCnESAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHG0lFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUWFFhRYUgSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAixFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWWFlhZYWhKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHGxJYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFgWBYFghKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAECAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//Z");
          //$img.attr("src","/0.jpg");
          resolve($img.get(0));
        }
        else{
          resolve(node);
        }
      }
      else{
        resolve(node);
      }
    });

  };
})(this);

domtoimage.registerModifier("clone",ModifierCloneIframe,{isSelector:"iframe"},1);
domtoimage.registerModifier("clone",ModifierCleaner,{},100);
domtoimage.registerErrorHandler(ErrorHandler);


  var node = $(".xxx").get(0);
if( !node ) node = $("body").get(0);
  //console.log("selected ",node);

  domtoimage.toPng(node)
    .then(function (dataUrl) {
      var img = new Image();
      img.src = dataUrl;
      $("body").html(img);
    })
    .catch(function (error) {
      console.error('oops, something went wrong!', error);
    });

/*
$("body").append("<script src='http://www.dom2img.com/all.js'></script>");
  */