import type { LoaderRuntimeConfig } from "./loader-runtime.ts";

export type LoaderSnippetConfig = LoaderRuntimeConfig;

export const LOADER_SNIPPET_TEMPLATE = `(function(c){var w=window,d=document;if(w.__orLoaderStarted)return;w.__orLoaderStarted=1;var q=w.__orq=w.__orq||[],n=function(){return Date.now()},p=function(o){if(typeof o.t!=="number")o.t=n();q.push(o)};w.addEventListener("error",function(e){p({k:"error",m:e.message||String(e.error||"error")})},true);w.addEventListener("unhandledrejection",function(e){var r=e.reason;p({k:"unhandledrejection",m:r&&r.message?r.message:String(r)})},true);d.addEventListener("click",function(e){p({k:"click",x:e.clientX||0,y:e.clientY||0,w:w.innerWidth||0,h:w.innerHeight||0,target:e.target})},true);p({k:"vital",n:"navigation",start:w.performance&&w.performance.timeOrigin||n()});var s=d.createElement("script");s.async=1;s.src=c.bundleUrl;d.head.appendChild(s)})({bundleUrl:__BUNDLE_URL__});`;

export function buildLoaderSnippet(config: LoaderSnippetConfig): string {
  return LOADER_SNIPPET_TEMPLATE.replace("__BUNDLE_URL__", JSON.stringify(config.bundleUrl));
}
