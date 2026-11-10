module.exports=async function(req,res){
res.setHeader('Cache-Control','s-maxage=120, stale-while-revalidate=300');
res.setHeader('Access-Control-Allow-Origin','*');
var q=String(req.query&&req.query.q||'').trim().slice(0,140);
if(!q)return res.status(400).json({error:'Search query required',results:[]});
var n=Math.min(20,Math.max(1,Number(req.query&&req.query.limit)||10));
try{
var r=await fetch('https://api.openverse.org/v1/audio/?q='+encodeURIComponent(q)+'&page_size='+n+'&mature=false');
if(!r.ok)throw new Error('Provider unavailable');
var j=await r.json();
var a=(j.results||[]).map(function(t){var l=String(t.license||'').toLowerCase(),m=l==='by'||l==='by-sa',d=Number(t.duration)||0;if(d>10000)d=Math.round(d/1000);return{id:'openverse-'+t.id,provider:t.provider||'Openverse',title:t.title||'Untitled',artist:t.creator||'Unknown artist',duration:d,bpm:null,energy:null,artwork:t.thumbnail||'',streamUrl:t.url||'',landingUrl:t.foreign_landing_url||'',license:l,licenseUrl:t.license_url||'',attribution:t.attribution||'',mixReady:m,tags:t.tags||'',rights:m?'mix-eligible-licence':'playback-rights-unverified'};}).filter(function(t){return !!t.streamUrl;});
return res.status(200).json({query:q,count:a.length,results:a,providers:{openverse:true},notice:'Only CC BY and CC BY-SA tracks are marked mix-eligible. Check public-performance and commercial rights separately.'});
}catch(e){return res.status(200).json({query:q,count:0,results:[],providers:{openverse:false},error:'Open catalogue temporarily unavailable.'});}
};
