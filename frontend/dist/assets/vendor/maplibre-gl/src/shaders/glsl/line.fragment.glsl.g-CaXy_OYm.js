const a=`flat in vec2 v_width2;in vec2 v_normal;in float v_gamma_scale;
#ifdef GLOBE
in float v_depth;
#endif
#pragma maplibre: define highp vec4 color
#pragma maplibre: define lowp float blur
#pragma maplibre: define lowp float opacity
void main() {
#pragma maplibre: initialize highp vec4 color
#pragma maplibre: initialize lowp float blur
#pragma maplibre: initialize lowp float opacity
clipAntimeridian();float dist=length(v_normal)*v_width2.s;float blur2=(blur+1.0/u_device_pixel_ratio)*v_gamma_scale;float alpha=clamp(min(dist-(v_width2.t-blur2),v_width2.s-dist)/blur2,0.0,1.0);fragColor=color*(alpha*opacity);
#ifdef GLOBE
if (v_depth > 1.0) {discard;}
#endif
#ifdef OVERDRAW_INSPECTOR
fragColor=vec4(1.0);
#endif
}`;export{a as default};
