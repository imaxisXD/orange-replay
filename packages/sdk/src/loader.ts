import type { LoaderRuntimeConfig } from "./loader-runtime.ts";

export type LoaderSnippetConfig = LoaderRuntimeConfig;

export const LOADER_SNIPPET_TEMPLATE = `(function(c){var w=window,d=document;if(w.__orLoaderStarted)return;w.__orLoaderStarted=1;var q=w.__orq=w.__orq||[],r=w.__orCleanup=w.__orCleanup||[],l=c.queueLimit>0?Math.floor(c.queueLimit):100,b="[data-orange-block]"+(c.init&&c.init.blockSelector?", "+c.init.blockSelector:""),n=function(){return Date.now()},t=function(v){v=String(v);return v.length>200?v.slice(0,200):v},p=function(o){if(typeof o.t!=="number")o.t=n();if(q.length>=l)q.splice(0,q.length-l+1);q.push(o)},a=function(x,y,f){x.addEventListener(y,f,true);r.push(function(){x.removeEventListener(y,f,true)})},h=function(v){return String(v).replace(/[^a-zA-Z0-9_-]/g,"_")},g=function(e){var z=e.tagName.toLowerCase(),i=e.id?"#"+h(e.id):"",c="",j=0;if(e.classList)for(;j<e.classList.length&&j<3;j++)c+="."+h(e.classList[j]);return z+i+c},s=function(e){if(!e||!e.tagName)return"unknown";for(var p=[],x=e;x&&p.length<3;x=x.parentElement)p.unshift(g(x));return t(p.join(" > "))},m=function(e){try{return e&&e.closest&&e.closest(b)?"[blocked]":s(e)}catch(_){try{return e&&e.closest&&e.closest("[data-orange-block]")?"[blocked]":s(e)}catch(_){return s(e)}}};if(c.init){w.__orInit=c.init;p({k:"init",o:c.init})}a(w,"error",function(e){p({k:"error",m:t(e.message||String(e.error||"error"))})});a(w,"unhandledrejection",function(e){var r=e.reason;p({k:"unhandledrejection",m:t(r&&r.message?r.message:String(r))})});a(d,"click",function(e){p({k:"click",d:m(e.target),x:e.clientX||0,y:e.clientY||0,w:w.innerWidth||0,h:w.innerHeight||0})});p({k:"vital",n:"navigation",start:w.performance&&w.performance.timeOrigin||n()});var o=d.createElement("script");o.async=1;o.src=c.bundleUrl;d.head.appendChild(o)})({bundleUrl:__BUNDLE_URL__,init:__INIT_CONFIG__});`;

export function buildLoaderSnippet(config: LoaderSnippetConfig): string {
  return LOADER_SNIPPET_TEMPLATE.replace(
    "__BUNDLE_URL__",
    JSON.stringify(config.bundleUrl),
  ).replace(
    "__INIT_CONFIG__",
    config.init === undefined ? "undefined" : JSON.stringify(config.init),
  );
}
