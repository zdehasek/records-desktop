function m(e){return`msg-${e.id}`}function r(e,n,t){return n.find(i=>(t[i.id]||[]).some(d=>d.id===e))}export{r as findMessageByAttachmentId,m as getTimelineItemKey};
