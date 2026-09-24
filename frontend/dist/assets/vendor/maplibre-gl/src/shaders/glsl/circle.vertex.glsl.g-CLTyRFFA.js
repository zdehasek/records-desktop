const e=`uniform bool u_scale_with_map;uniform bool u_pitch_with_map;uniform vec2 u_extrude_scale;uniform highp float u_globe_extrude_scale;uniform vec2 u_translate;layout(location=0) in ivec2 a_pos;out vec3 v_data;flat out float v_visibility;
#pragma maplibre: define highp vec4 color
#pragma maplibre: define mediump float radius
#pragma maplibre: define lowp float blur
#pragma maplibre: define lowp float opacity
#pragma maplibre: define highp vec4 stroke_color
#pragma maplibre: define mediump float stroke_width
#pragma maplibre: define lowp float stroke_opacity
void main(void) {
#pragma maplibre: initialize highp vec4 color
#pragma maplibre: initialize mediump float radius
#pragma maplibre: initialize lowp float blur
#pragma maplibre: initialize lowp float opacity
#pragma maplibre: initialize highp vec4 stroke_color
#pragma maplibre: initialize mediump float stroke_width
#pragma maplibre: initialize lowp float stroke_opacity
ivec2 pos_raw=a_pos+32768;vec2 extrude=vec2(pos_raw & 7)/7.0*2.0-1.0;vec2 circle_center=vec2(pos_raw >> 3)+u_translate;float ele=get_elevation(circle_center);v_visibility=calculate_visibility(projectTileWithElevation(circle_center,ele));if (u_pitch_with_map) {
#ifdef GLOBE
vec3 center_vector=projectToSphere(circle_center);
#endif
float angle_scale=u_globe_extrude_scale;vec2 corner_position=circle_center;if (u_scale_with_map) {angle_scale*=(radius+stroke_width);corner_position+=extrude*u_extrude_scale*(radius+stroke_width);} else {
#ifdef GLOBE
vec4 projected_center=interpolateProjection(circle_center,center_vector,ele);
#else
vec4 projected_center=projectTileWithElevation(circle_center,ele);
#endif
corner_position+=extrude*u_extrude_scale*(radius+stroke_width)*(projected_center.w/u_camera_to_center_distance);angle_scale*=(radius+stroke_width)*(projected_center.w/u_camera_to_center_distance);}
#ifdef GLOBE
vec2 angles=extrude*angle_scale;vec3 corner_vector=globeRotateVector(center_vector,angles);gl_Position=interpolateProjection(corner_position,corner_vector,ele);
#else
gl_Position=projectTileWithElevation(corner_position,ele);
#endif
} else {gl_Position=projectTileWithElevation(circle_center,ele);if (gl_Position.z/gl_Position.w > 1.0) {gl_Position.xy=vec2(10000.0);}if (u_scale_with_map) {gl_Position.xy+=extrude*(radius+stroke_width)*u_extrude_scale*u_camera_to_center_distance;} else {gl_Position.xy+=extrude*(radius+stroke_width)*u_extrude_scale*gl_Position.w;}}float antialiasblur=-max(1.0/u_device_pixel_ratio/(radius+stroke_width),blur);v_data=vec3(extrude.x,extrude.y,antialiasblur);}`;export{e as default};
