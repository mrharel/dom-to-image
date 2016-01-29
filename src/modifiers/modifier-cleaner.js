(function(global){
    'use strict';

    //do not use this since it breaks the rendering...
    global.StyleCleaner = function(xml){
      var regex = [
        /animation: none 0s ease 0s 1 normal none running;/g,
        /motion: none 0px auto 0deg;/g,
        /outline: rgb(0, 0, 0) none 0px;/g,
        /opacity: 1;/g,
        /position: static;/g,
        /transition: all 0s ease 0s;/g,
        /visibility: visible;/g,
        /[a-zA-Z0-9\-]+: (normal|auto|none|0px);/g,
        ///background-blend-mode: normal;/g,
        ///border-radius: 0px;/g,
        ///border-image-outset: 0px/g,
        ///border-image-source: none;/g,
        ///bottom: auto;/g,
        ///box-shadow: none;/g,
        ///cursor: auto;/g,
        /direction: ltr;/g,
        ///float: none;/g,
        ///font-kerning: auto;/g,
        ///font-stretch: normal;/g,
        ///font-style: normal;/g,
        ///font-variant: normal;/g,
        ///font-variant-ligatures: normal;/g,
        ///font-weight: normal;/g,
        ///image-rendering: auto;/g,
        ///isolation: auto;/g,
        ///left: auto;/g,
        ///letter-spacing: normal;/g,
        ///line-height: normal;/g,
        ///max-height: none;/g,
        ///max-width: none;/g,
        ///min-height: 0px;/g,
        ///min-width: 0px;/g,
        ///mix-blend-mode: normal;/g







      ];
      for( var i=0; i<regex.length; i++ ){
        xml = xml.replace(regex[i],"");
      }
      return xml;
    };

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