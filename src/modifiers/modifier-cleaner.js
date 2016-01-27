(function(global){
    'use strict';

    global.ModifierCleaner = function(data){

        var node = data.node;
        return new Promise(function(resolve,reject){
            var display = $(node).css("display");
            if( display === "none"){
                resolve();
                return;
            }
            switch( node.tagName ){
                case 'SCRIPT':
                case 'STYLE':
                case 'LINK':
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