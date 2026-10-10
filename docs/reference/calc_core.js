var W=[.07,.07,.07,.05,.06,.09,.13,.14,.10,.06,.05,.11];
var MN=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
var MS=['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
var MG=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
var LIM_EX=20e6, LIM5=272.5e6, LIM7=490.5e6;
var RATES=[5,7,22];
var ENT=[
 {id:'alfa',name:'ООО «Альфа»',form:'ООО',owner:'Собственник 1',payer:true, annual:28.4e6,p:0.82,color:'#13191F',desc:'Аренда без экипажа: люкс и внедорожники'},
 {id:'beta',name:'ИП Бета',form:'ИП',owner:'Собственник 1',payer:true, annual:22.0e6,p:0.34,color:'#906D4B',desc:'Аренда без экипажа: комфорт и внедорожники'},
 {id:'delta',name:'ИП Дельта',form:'ИП',owner:'Собственник 2',payer:false,annual:20.9e6,p:0.18,color:'#CA9C68',desc:'Аренда без экипажа: комфорт'},
 {id:'gamma',name:'ООО «Гамма»',form:'ООО',owner:'Собственник 2',payer:false,annual:6.4e6,p:0.80,color:'#E3D2BC',desc:'Аренда с экипажем и трансферы'}
];
function ent(id){return ENT.filter(function(e){return e.id===id})[0]}
function dim(y,m){return new Date(y,m+1,0).getDate()}
function frac(d){
  var y=d.getFullYear(),m=d.getMonth(),s=0,i;
  for(i=0;i<m;i++)s+=W[i];
  var f=((d.getDate()-1)+(d.getHours()*3600+d.getMinutes()*60+d.getSeconds()+d.getMilliseconds()/1000)/86400)/dim(y,m);
  return s+W[m]*f;
}
function ytd(e,d){return e.annual*frac(d)}
function taxFor(rate,R,p){
  if(rate===5)return R*5/105;
  if(rate===7)return R*7/107;
  return R*22/122*(1-p);
}
function crossing(e,d){
  if(e.payer)return null;
  var y=d.getFullYear(),m=d.getMonth(),i,cum=0;
  for(i=0;i<m;i++)cum+=W[i];
  cum=e.annual*(cum+W[m]*d.getDate()/dim(y,m));
  if(cum>=LIM_EX)return new Date(y,m,d.getDate());
  var day=new Date(y,m,d.getDate()+1);
  while(day.getFullYear()===y){
    cum+=e.annual*W[day.getMonth()]/dim(y,day.getMonth());
    if(cum>=LIM_EX)return new Date(day.getTime());
    day=new Date(y,day.getMonth(),day.getDate()+1);
  }
  return null;
}
/* налогооблагаемая выручка до конца года: у плательщика весь год, у освобождённого после месяца пересечения */
function baseRev(e,d){
  if(e.payer)return e.annual;
  var c=crossing(e,d); if(!c)return 0;
  var sm=c.getMonth()+1; if(sm>11)return 0;
  var s=0,i; for(i=sm;i<12;i++)s+=W[i];
  return e.annual*s;
}
function forecast(e,rate,d){return taxFor(rate,baseRev(e,d),e.p)}
function bestRate(e,d){
  var b=RATES[0],i; for(i=1;i<RATES.length;i++){ if(forecast(e,RATES[i],d)<forecast(e,b,d))b=RATES[i]; }
  return b;
}
var SEL={alfa:5,beta:5,delta:5,gamma:5};
var d=new Date(2026,9,10,12,0,0);
ENT.forEach(function(e){console.log(e.id,e.payer,'ytd',Math.round(ytd(e,d)),'t5',Math.round(taxFor(5,e.annual,e.p)),'t7',Math.round(taxFor(7,e.annual,e.p)),'t22',Math.round(taxFor(22,e.annual,e.p)),'best',bestRate(e,d),'base',Math.round(baseRev(e,d)),'cross',crossing(e,d)&&crossing(e,d).toISOString().slice(0,10),'f5',Math.round(forecast(e,5,d)),'f22',Math.round(forecast(e,22,d)))});
console.log('frac',frac(d));
