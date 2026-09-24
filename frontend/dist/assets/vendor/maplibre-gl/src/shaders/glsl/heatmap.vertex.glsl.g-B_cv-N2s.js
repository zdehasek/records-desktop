const e=`uniform float u_extrude_scale;uniform float u_opacity;uniform float u_intensity;uniform highp float u_globe_extrude_scale;layout(location=0) in ivec2 a_pos;out vec2 v_extrude;
#pragma maplibre: define highp float weight
#pragma maplibre: define mediump float radius
const highp float ZERO=1.0/255.0/16.0;
#define GAUSS_COEF 0.3989422804014327
void main(void) {
#pragma maplibre: initialize highp float weight
#pragma maplibre: initialize mediump float radius
ivec2 pos_raw=a_pos+32768;vec2 unscaled_extrude=vec2(pos_raw & 7)/7.0*2.0-1.0;float S=sqrt(-2.0*log(ZERO/weight/u_intensity/GAUSS_COEF))/3.0;v_extrude=S*unscaled_extrude;vec2 extrude=v_extrude*radius*u_extrude_scale;vec2 circle_center=vec2(pos_raw >> 3);
#ifdef GLOBE
vec2 angles=v_extrude*radius*u_globe_extrude_scale;vec3 center_vector=projectToSphere(circle_center);vec3 corner_vector=globeRotateVector(center_vector,angles);gl_Position=interpolateProjection(circle_center+extrude,corner_vector,0.0);
#else
gl_Position=projectTileFor3D(circle_center+extrude,get_elevation(circle_center));
#endif
}`;export{e as default};
