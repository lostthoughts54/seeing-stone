const fs = require('node:fs');
const WebSocket = require('ws');
(async () => {
  const pages = await (await fetch('http://127.0.0.1:9335/json')).json();
  const page = pages.find(p => p.url === 'app://bundle/index.html');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const expression = fs.readFileSync(process.argv[2], 'utf8');
  socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
  socket.on('message', data => { const reply=JSON.parse(data); if(reply.id===1){ console.log(JSON.stringify(reply.result)); socket.close(); }});
  setTimeout(() => { socket.close(); process.exit(1); }, 45000).unref();
})().catch(e => { console.error(e.message); process.exitCode=1; });
