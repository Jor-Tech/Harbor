'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
async function identity(dir){
 const file=path.join(dir,'mcp-server-identity.json');await fs.mkdir(dir,{recursive:true,mode:0o700});
 try{
  const h=await fs.open(file,require('node:fs').constants.O_RDONLY|require('node:fs').constants.O_NOFOLLOW);let saved;
  try{const stat=await h.stat();if(!stat.isFile()||stat.size>16384||(process.platform!=='win32'&&(stat.mode&0o077||stat.uid!==process.getuid())))throw new Error('Harbor MCP identity must be a private file.');saved=JSON.parse(await h.readFile('utf8'));}finally{await h.close()}
  const cert=new crypto.X509Certificate(saved.cert);if(!cert.checkPrivateKey(crypto.createPrivateKey(saved.key))||!cert.checkHost('harbor.local')||Date.parse(cert.validTo)<Date.now()||Date.parse(cert.validFrom)>Date.now())throw new Error('Harbor MCP identity is invalid or expired; re-pair clients after resetting it.');return saved;
 }catch(error){if(error.code!=='ENOENT')throw error;}
 require('reflect-metadata');const x509=require('@peculiar/x509');x509.cryptoProvider.set(crypto.webcrypto);
 const keys=await crypto.webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const cert=await x509.X509CertificateGenerator.createSelfSigned({serialNumber:crypto.randomBytes(16).toString('hex'),name:'CN=harbor.local',notBefore:new Date(Date.now()-300000),notAfter:new Date(Date.now()+10*365*86400000),signingAlgorithm:{name:'ECDSA',hash:'SHA-256'},keys,extensions:[new x509.SubjectAlternativeNameExtension([{type:'dns',value:'harbor.local'}]),new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'])]});
 const key=crypto.createPrivateKey({key:Buffer.from(await crypto.webcrypto.subtle.exportKey('pkcs8',keys.privateKey)),format:'der',type:'pkcs8'}).export({type:'pkcs8',format:'pem'}),saved={key,cert:cert.toString('pem')};
 await fs.writeFile(file,JSON.stringify(saved),{mode:0o600,flag:'wx'});return saved;
}
module.exports={identity};
