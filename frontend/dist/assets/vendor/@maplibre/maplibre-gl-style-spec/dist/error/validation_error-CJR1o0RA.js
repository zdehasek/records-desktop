var o=class{constructor(r,i,t,s,_="error"){this.message=(r?`${r}: `:"")+t,s&&(this.identifier=s),this.severity=_,i!=null&&i.__line__&&(this.line=i.__line__)}};export{o as ValidationError};
