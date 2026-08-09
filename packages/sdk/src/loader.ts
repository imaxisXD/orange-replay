import type { LoaderRuntimeConfig } from "./loader-runtime.ts";

export type LoaderSnippetConfig = LoaderRuntimeConfig;

export const LOADER_SNIPPET_TEMPLATE = `(function(c){var w=window,d=document;if(w.__orLoaderStarted)return;w.__orLoaderStarted=1;var q=w.__orq=w.__orq||[],r=w.__orCleanup=w.__orCleanup||[],l=__QUEUE_LIMIT__,b="[data-orange-block]"+(c.init&&c.init.blockSelector?", "+c.init.blockSelector:""),n=function(){return Date.now()},t=function(v){v=String(v);return v.length>200?v.slice(0,200):v},p=function(o){if(typeof o.t!=="number")o.t=n();if(q.length>=l)q.splice(0,q.length-l+1);q.push(o)},a=function(x,y,f){x.addEventListener(y,f,true);r.push(function(){x.removeEventListener(y,f,true)})},h=function(v){return String(v).replace(/[^a-zA-Z0-9_-]/g,"_")},g=function(e){var z=e.tagName.toLowerCase(),i=e.id?"#"+h(e.id):"",c="",j=0;if(e.classList)for(;j<e.classList.length&&j<3;j++)c+="."+h(e.classList[j]);return z+i+c},s=function(e){if(!e||!e.tagName)return"unknown";for(var p=[],x=e;x&&p.length<3;x=x.parentElement)p.unshift(g(x));return t(p.join(" > "))},m=function(e){try{return e&&e.closest&&e.closest(b)?"[blocked]":s(e)}catch(_){try{return e&&e.closest&&e.closest("[data-orange-block]")?"[blocked]":s(e)}catch(_){return s(e)}}},D=function(){q.splice(0);for(var f;r.length;)try{(f=r.pop())()}catch(_){}w.__orq={push:function(){return 0}}},J=function(u){var o=d.createElement("script");o.async=1;o.src=u;o.onerror=function(){var i=c.init;if(!i||!i.key||!i.ingestUrl)return;try{fetch(String(i.ingestUrl).replace(/\\/+$/,"")+"/v1/sdk-health",{method:"POST",headers:{"content-type":"application/json","x-or-key":i.key},body:'{"version":1,"code":"bundle_load_failed"}',cache:"no-store",credentials:"omit",keepalive:true}).catch(function(){})}catch(_){}};d.head.appendChild(o)},H=function(v){for(var x=2166136261,j=0;j<v.length;j++)x=Math.imul(x^v.charCodeAt(j),16777619);return(x>>>0)/4294967296},G=function(v){return Math.floor(H(v)*4294967296).toString(36)};if(c.init){w.__orInit=c.init;p({k:"init",o:c.init})}a(w,"error",function(e){p({k:"error",m:t(e.message||String(e.error||"error"))})});a(w,"unhandledrejection",function(e){var r=e.reason;p({k:"unhandledrejection",m:t(r&&r.message?r.message:String(r))})});a(d,"click",function(e){p({k:"click",d:m(e.target),x:e.clientX||0,y:e.clientY||0,w:w.innerWidth||0,h:w.innerHeight||0})});p({k:"vital",start:w.performance&&w.performance.timeOrigin||n(),u:w.location.href});var i=c.init;if(!i||!i.key||!i.ingestUrl){J(c.bundleUrl);return}var e=String(i.ingestUrl).replace(/\\/+$/,"");var Q=new AbortController,V=setTimeout(function(){Q.abort()},2e3);fetch(e+"/v1/config",{headers:{"x-or-key":i.key},cache:"no-store",credentials:"omit",signal:Q.signal}).then(function(x){if(!x.ok)throw 0;return x.json()}).then(function(z){if(!z||typeof z.sampleRate!=="number"||z.sampleRate<0||z.sampleRate>1)throw 0;var u=c.bundleUrl;if(z.recorderUrl){var A=new URL(z.recorderUrl,e);if(A.origin!==new URL(e).origin)throw 0;u=A.href}var v=z.sessionScope||z.projectId||i.key;if(typeof v!=="string"||!/^[A-Za-z0-9_-]{1,64}$/.test(v))throw 0;var K=G(v)+G("scope:"+v),S="or:"+K+":",O=w.sessionStorage,N=n(),I,Oa;try{I=O.getItem(S+"s");Oa=Number(O.getItem(S+"last"));if(N-Oa>=6e5)I=""}catch(_){}var B=z.sessionCookieDomain,R=w.location.hostname.toLowerCase();if(B!==undefined){if(typeof B!=="string"||B.length>253||!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(B))throw 0;B=B.toLowerCase();if(R!==B&&!R.endsWith("."+B))throw 0}var C=w.location.protocol==="https:",P=C?(B?"__Secure-or_s_":"__Host-or_s_")+K:"";if(P)for(var X=d.cookie.split(";"),Y=0;Y<X.length;Y++){var E=X[Y].trim();if(E.indexOf(P+"=")===0){var T=E.slice(P.length+1);if(/^[A-Za-z0-9_-]{16,64}$/.test(T))I=T}}if(!I)I=crypto.randomUUID();try{O.setItem(S+"s",I);O.setItem(S+"last",String(N))}catch(_){}if(P)d.cookie=P+"="+I+"; Path=/; Max-Age=600; SameSite=Lax; Secure"+(B?"; Domain="+B:"");var L=typeof i.sampleRate==="number"?Math.max(0,Math.min(1,i.sampleRate)):1;if(H(I)>=Math.min(L,z.sampleRate)){D();return}w.__orConfig=z;J(u)}).catch(function(){J(c.bundleUrl)}).finally(function(){clearTimeout(V)})})({bundleUrl:__BUNDLE_URL__,init:__INIT_CONFIG__});`;

export function buildLoaderSnippet(config: LoaderSnippetConfig): string {
  return LOADER_SNIPPET_TEMPLATE.replace(
    /__BUNDLE_URL__|__INIT_CONFIG__|__QUEUE_LIMIT__/g,
    (match) => {
      if (match === "__BUNDLE_URL__") return serializeForInlineScript(config.bundleUrl);
      if (match === "__QUEUE_LIMIT__") return serializeQueueLimit(config.queueLimit);
      return config.init === undefined ? "undefined" : serializeForInlineScript(config.init);
    },
  );
}

export function buildLoaderScriptTag(config: LoaderSnippetConfig): string {
  return `<script>\n${buildLoaderSnippet(config)}\n</script>`;
}

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return char;
    }
  });
}

function serializeQueueLimit(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) || value < 1
    ? "100"
    : String(Math.floor(value));
}
