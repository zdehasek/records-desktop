function e(n,t){return t.replace(/{([^{}]+)}/g,(c,r)=>n&&r in n?String(n[r]):"")}export{e as resolveTokens};
