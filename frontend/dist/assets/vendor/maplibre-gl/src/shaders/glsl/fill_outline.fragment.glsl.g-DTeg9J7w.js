const i=`in vec2 v_pos;
#ifdef GLOBE
in float v_depth;
#endif
#pragma maplibre: define highp vec4 outline_color
#pragma maplibre: define lowp float opacity
void main() {
#pragma maplibre: initialize highp vec4 outline_color
#pragma maplibre: initialize lowp float opacity
float dist=length(v_pos-gl_FragCoord.xy);float alpha=1.0-smoothstep(0.0,1.0,dist);fragColor=outline_color*(alpha*opacity);
#ifdef GLOBE
if (v_depth > 1.0) {discard;}
#endif
#ifdef OVERDRAW_INSPECTOR
fragColor=vec4(1.0);
#endif
}`;export{i as default};
