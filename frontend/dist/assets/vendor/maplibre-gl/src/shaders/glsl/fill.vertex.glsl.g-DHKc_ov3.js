const i=`uniform vec2 u_fill_translate;layout(location=0) in vec2 a_pos;
#pragma maplibre: define highp vec4 color
#pragma maplibre: define lowp float opacity
void main() {
#pragma maplibre: initialize highp vec4 color
#pragma maplibre: initialize lowp float opacity
if (opacity < 0.01) {gl_Position=vec4(-2.0,-2.0,-2.0,1.0);return;}gl_Position=projectTile(a_pos+u_fill_translate,a_pos);}`;export{i as default};
