function r(e){return e instanceof Number?"number":e instanceof String?"string":e instanceof Boolean?"boolean":Array.isArray(e)?"array":e===null?"null":typeof e}export{r as getType};
