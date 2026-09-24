function e(r,i){return!Number.isFinite(r)||!Number.isFinite(i)||r<-90||r>90||i<-180||i>180?"":`${r.toFixed(4)}, ${i.toFixed(4)}`}export{e as formatCoords};
