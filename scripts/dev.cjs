const {spawn} = require('node:child_process');
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js'],{stdio:'inherit'});
let desktop;
(async()=>{for(let n=0;n<100;n++){try{await fetch('http://127.0.0.1:5173');desktop=spawn(require('electron'),['.'],{stdio:'inherit',env:{...process.env,HARBOR_DEV_URL:'http://127.0.0.1:5173'}});desktop.on('exit',()=>{server.kill();process.exit()});return;}catch{await new Promise(r=>setTimeout(r,100));}}server.kill();process.exit(1)})();
process.on('SIGINT',()=>{desktop?.kill();server.kill();process.exit()});
