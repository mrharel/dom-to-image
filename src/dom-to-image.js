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
        if( type !== 'clone' && type !== 'style'&& type !== 'error' && type !== 'xml' ){
            throw new Error("Unknown modifier type " + type);
        }
        if( !modifierGroups[groupName] ){
            modifierGroups[groupName] = {
                clone : [],
                style : [],
                xml : []
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
                if( !clone ) return null;
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
                if( !node ) return null;
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

    function makeSvgDataUri(node, width, height,groupName) {
        //root node should not be with margin.
        node.style.marginBottom = 0;
        node.style.marginTop = 0;
        node.style.marginLeft = 0;
        node.style.marginRight = 0;


        return Promise.resolve(node)
            .then(function (node) {
                node.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
                var xml =  new XMLSerializer().serializeToString(node);

                var modArr = getModifiers("xml",node,groupName) || [];
                //var arr = [];
                var modifiedXml = xml;
                for( var i=0; i<modArr.length ; i++ ){
                  var result = modArr[i].modifier(modifiedXml);
                    if( result ){
                        modifiedXml = result;
                    }
                }
                console.log("*** XML START ***");
                console.log(modifiedXml);
                console.log("*** XML END ***");
                return modifiedXml;
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

        function isImage(url){
            return /\.(png|jpg|jpeg|bmp|gif|tiff|svg|webp)(\?.*|#.*|)$/.test(url);
        }

        function loadImage(url){
            return new Promise( function(resolve,reject){
                var img = new Image,
                  canvas = document.createElement("canvas"),
                  ctx = canvas.getContext("2d"),
                  src = url;

                img.crossOrigin = "Anonymous";

                img.onload = function() {
                    canvas.width = img.width;
                    canvas.height = img.height;
                    ctx.drawImage( img, 0, 0 );
                    //localStorage.setItem( "savedImageData", canvas.toDataURL("image/png") );
                    var content = canvas.toDataURL("image/png").split(/,/)[1];
                    resolve(content);
                };
                img.onerror = function(){
                    var modArr = errorHandlers;
                    if( !modArr.length ){
                        reject(new Error('Cannot fetch resource ' + url ));
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
                          reject(new Error('Cannot fetch resource ' + url));

                      },function(){
                          reject(new Error('Cannot fetch resource ' + url ));
                      });
                }
                img.src = src;
    // make sure the load event fires for cached images too
                if ( img.complete || img.complete === undefined ) {
                    //img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
                    //img.src = src;
                    console.log("***** image was cached, what do we do?");
                }

            });
        }

        function getAndEncode(url) {
            const TIMEOUT = 30000;

            //after some test i decided not to use that... was causing too much
            //problems in loading images...
            //if( isImage(url) ){
            //    return loadImage(url);
            //}

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
                        //var content = encoder.result.split(/,/)[1];
                        var content = encoder.result;
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
            //return 'data:' + type + ';base64,' + content;
            return content;
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
                        var mime = util.mimeType(element.src);
                        return util.dataAsUrl(data, mime );
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
