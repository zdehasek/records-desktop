function d(n,o,r){const e=t(n,o)-r,c=t(n>>1,o)-r;return{x:e,y:c}}function t(n,o){let r=0;for(let e=0;e<o;e++)r|=(n&1<<2*e)>>e;return r}export{d as decodeZOrderCurve};
