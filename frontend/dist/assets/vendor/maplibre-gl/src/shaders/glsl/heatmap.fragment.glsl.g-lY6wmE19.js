const e=`uniform highp float u_intensity;in vec2 v_extrude;
#pragma maplibre: define highp float weight
#define GAUSS_COEF 0.3989422804014327
void main() {
#pragma maplibre: initialize highp float weight
float d=-0.5*3.0*3.0*dot(v_extrude,v_extrude);float val=weight*u_intensity*GAUSS_COEF*exp(d);fragColor=vec4(val,1.0,1.0,1.0);
#ifdef OVERDRAW_INSPECTOR
fragColor=vec4(1.0);
#endif
}`;export{e as default};
