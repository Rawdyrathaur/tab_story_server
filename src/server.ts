import http from 'node:http';
import cors from 'cors';
import express from 'express';
import { Server } from 'socket.io';
import { ZodError, z } from 'zod';
import { accessToken, hashToken, matchesToken, refreshToken, verifyAccess, verifyRefresh, type Claims } from './auth.js';
import { config } from './config.js';
import { prisma, pull, purgeTombstones, push } from './sync.js';

const app=express();
app.use(cors({origin:config.origins.length?config.origins:true,credentials:true}));
app.use(express.json({limit:'2mb'}));

const deviceRequest=z.object({deviceId:z.string().min(1),userId:z.string().uuid().optional(),bootstrapSecret:z.string()});
app.get('/health',(_req,res)=>res.json({ok:true}));
app.get('/config',(_req,res)=>res.json({pullPageSize:200,freeTabSaving:true,premiumFeatures:['ai-tools']}));
app.post('/auth/device',async(req,res,next)=>{try{
  const body=deviceRequest.parse(req.body);
  if(body.bootstrapSecret!==config.bootstrapSecret)return res.status(401).json({error:'INVALID_BOOTSTRAP_SECRET'});
  const userId=body.userId??crypto.randomUUID();
  const user=await prisma.user.upsert({where:{id:userId},create:{id:userId},update:{},select:{tier:true}});
  const claims={userId,deviceId:body.deviceId}; const refresh=refreshToken(claims);
  await prisma.device.upsert({where:{userId_id:{userId,id:body.deviceId}},create:{userId,id:body.deviceId,refreshTokenHash:await hashToken(refresh)},update:{refreshTokenHash:await hashToken(refresh)}});
  res.json({userId,deviceId:body.deviceId,tier:user.tier,accessToken:accessToken(claims),refreshToken:refresh});
}catch(error){next(error)}});

const server=http.createServer(app);
const io=new Server(server,{cors:{origin:config.origins.length?config.origins:true,credentials:true},maxHttpBufferSize:2_000_000});
type AuthedSocket={data:{claims:Claims}};
io.use(async(socket,next)=>{try{
  const auth=socket.handshake.auth as {accessToken?:string;refreshToken?:string}; let claims:Claims;
  try{claims=verifyAccess(String(auth.accessToken||''));}
  catch{claims=verifyRefresh(String(auth.refreshToken||'')); const device=await prisma.device.findUnique({where:{userId_id:{userId:claims.userId,id:claims.deviceId}}});if(!device?.refreshTokenHash||!(await matchesToken(String(auth.refreshToken),device.refreshTokenHash)))throw new Error('Invalid refresh token');socket.emit('auth:access-token',{accessToken:accessToken(claims)});}
  const device=await prisma.device.findUnique({where:{userId_id:{userId:claims.userId,id:claims.deviceId}}}); if(!device)throw new Error('Unknown device');
  (socket as unknown as AuthedSocket).data.claims=claims; next();
}catch{next(new Error('AUTH_REQUIRED'))}});

io.on('connection',socket=>{
  const {userId,deviceId}=(socket as unknown as AuthedSocket).data.claims;
  socket.on('sync',async(payload:{changes?:unknown;cursor?:string},reply:(result:unknown)=>void)=>{try{
    const pushed=await push(userId,deviceId,payload?.changes??[]); const pages=[]; let cursor=BigInt(payload?.cursor||'0'); let page;
    let first=true;do{page=await pull(userId,deviceId,cursor,200,first);first=false;pages.push(page);cursor=BigInt(page.cursor);}while(page.hasMore);
    reply({ok:true,pushed,pages});
  }catch(error){reply({ok:false,error:error instanceof Error?error.message:'SYNC_FAILED'});}
  });
  socket.on('device:push-subscription',async(subscription:unknown,reply:(result:unknown)=>void)=>{try{await prisma.device.update({where:{userId_id:{userId,id:deviceId}},data:{pushSubscription:subscription as never}});reply({ok:true});}catch{reply({ok:false});}});
});

app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{if(error instanceof ZodError)return res.status(400).json({error:'INVALID_REQUEST',issues:error.issues});console.error(error);return res.status(500).json({error:'INTERNAL_ERROR'});});
setInterval(()=>void purgeTombstones().catch(console.error),6*60*60*1000).unref();
server.listen(config.port,()=>console.log(`Tab Story sync server listening on ${config.port}`));
