const e=`
#define scale 0.015873016
layout(location=0) in ivec2 a_pos_normal;layout(location=1) in uvec4 a_data;uniform vec2 u_translation;uniform mediump float u_ratio;out vec2 v_normal;flat out vec2 v_width2;out float v_gamma_scale;out highp float v_linesofar;
#ifdef GLOBE
out float v_depth;
#endif
#pragma maplibre: define highp vec4 color
#pragma maplibre: define lowp float blur
#pragma maplibre: define lowp float opacity
#pragma maplibre: define mediump float gapwidth
#pragma maplibre: define lowp float offset
#pragma maplibre: define mediump float width
void main() {
#pragma maplibre: initialize highp vec4 color
#pragma maplibre: initialize lowp float blur
#pragma maplibre: initialize lowp float opacity
#pragma maplibre: initialize mediump float gapwidth
#pragma maplibre: initialize lowp float offset
#pragma maplibre: initialize mediump float width
if (opacity < 0.01) {gl_Position=vec4(-2.0,-2.0,-2.0,1.0);return;}float ANTIALIASING=1.0/u_device_pixel_ratio/2.0;vec2 a_extrude=vec2(ivec2(a_data.xy)-128);float a_direction=float(int(a_data.z & 3u)-1);v_linesofar=float((a_data.z >> 2u)+a_data.w*64u)*2.0;vec2 pos=vec2(a_pos_normal >> 1);mediump vec2 normal=vec2(a_pos_normal & 1);normal.y=normal.y*2.0-1.0;v_normal=normal;gapwidth=gapwidth/2.0;float halfwidth=width/2.0;offset=-1.0*offset;float inset=gapwidth+(gapwidth > 0.0 ? ANTIALIASING : 0.0);float outset=gapwidth+halfwidth*(gapwidth > 0.0 ? 2.0 : 1.0)+(halfwidth==0.0 ? 0.0 : ANTIALIASING);mediump vec2 dist=outset*a_extrude*scale;mediump float u=0.5*a_direction;mediump float t=1.0-abs(u);mediump vec2 offset2=offset*a_extrude*scale*normal.y*mat2(t,-u,u,t);float adjustedThickness=projectLineThickness(pos.y);vec4 projected_no_extrude=projectTile(pos+offset2/u_ratio*adjustedThickness+u_translation);vec4 projected_with_extrude=projectTile(pos+offset2/u_ratio*adjustedThickness+u_translation+dist/u_ratio*adjustedThickness);gl_Position=projected_with_extrude;
#ifdef GLOBE
v_depth=gl_Position.z/gl_Position.w;
#endif
#ifdef TERRAIN3D
v_gamma_scale=1.0;
#else
float extrude_length_without_perspective=length(dist);float extrude_length_with_perspective=length((projected_with_extrude.xy-projected_no_extrude.xy)/projected_with_extrude.w*u_units_to_pixels);v_gamma_scale=extrude_length_without_perspective/extrude_length_with_perspective;
#endif
v_width2=vec2(outset,inset);}`;export{e as default};
