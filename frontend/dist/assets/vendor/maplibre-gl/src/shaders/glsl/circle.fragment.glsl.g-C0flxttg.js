const a=`in vec3 v_data;flat in float v_visibility;
#pragma maplibre: define highp vec4 color
#pragma maplibre: define mediump float radius
#pragma maplibre: define lowp float blur
#pragma maplibre: define lowp float opacity
#pragma maplibre: define highp vec4 stroke_color
#pragma maplibre: define mediump float stroke_width
#pragma maplibre: define lowp float stroke_opacity
void main() {
#pragma maplibre: initialize highp vec4 color
#pragma maplibre: initialize mediump float radius
#pragma maplibre: initialize lowp float blur
#pragma maplibre: initialize lowp float opacity
#pragma maplibre: initialize highp vec4 stroke_color
#pragma maplibre: initialize mediump float stroke_width
#pragma maplibre: initialize lowp float stroke_opacity
vec2 extrude=v_data.xy;float extrude_length=length(extrude);float antialiased_blur=v_data.z;float opacity_t=smoothstep(0.0,antialiased_blur,extrude_length-1.0);float color_t=stroke_width < 0.01 ? 0.0 : smoothstep(antialiased_blur,0.0,extrude_length-radius/(radius+stroke_width));fragColor=v_visibility*opacity_t*mix(color*opacity,stroke_color*stroke_opacity,color_t);const float epsilon=0.5/255.0;if (fragColor.r < epsilon && fragColor.g < epsilon && fragColor.b < epsilon && fragColor.a < epsilon) {discard;}
#ifdef OVERDRAW_INSPECTOR
fragColor=vec4(1.0);
#endif
}`;export{a as default};
