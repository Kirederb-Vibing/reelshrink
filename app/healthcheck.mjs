try {
  const r=await fetch(`http://127.0.0.1:${process.env.PORT||8080}/api/health`,{signal:AbortSignal.timeout(3500)});
  process.exit(r.ok && (await r.json()).status==='ok'?0:1);
} catch {process.exit(1);}
