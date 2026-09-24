function s(n,u){let e=!1,t=null,l;const r=()=>{t=null,e&&(n(...l),t=setTimeout(r,u),e=!1)};return(...i)=>(e=!0,l=i,t||r(),t)}export{s as throttle};
