import { Prisma, PrismaClient } from '@prisma/client'; import { z } from 'zod'; import { config } from './config.js';
export const prisma=new PrismaClient();
const change=z.object({id:z.string().uuid(),type:z.enum(['collection','resource','note','reminder']),content:z.record(z.string(),z.unknown()),collectionId:z.string().uuid().nullable().optional(),isDeleted:z.boolean(),editedAt:z.string().datetime(),editedBy:z.string().min(1)});
export type Change=z.infer<typeof change>;
const json=(value:unknown)=>value as Prisma.InputJsonValue;
const wire=(row:{serverVersion:bigint;editedAt:Date}&Record<string,unknown>)=>({...row,serverVersion:row.serverVersion.toString(),editedAt:row.editedAt.toISOString()});

const isSerializationFailure=(error:unknown)=>error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2034';
async function serializable<T>(work:(tx:Prisma.TransactionClient)=>Promise<T>):Promise<T>{
 for(let attempt=0;attempt<3;attempt++){
  try{return await prisma.$transaction(work,{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});}
  catch(error){if(!isSerializationFailure(error)||attempt===2)throw error;}
 }
 throw new Error('TRANSACTION_FAILED');
}

export async function push(userId:string,deviceId:string,input:unknown){
 const changes=z.array(change).max(500).parse(input); const authoritative:unknown[]=[]; const rejected:unknown[]=[];
 for(const candidate of changes){
  const result=await serializable(async tx=>{
   await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${userId} FOR UPDATE`;
   const user=await tx.user.findUniqueOrThrow({where:{id:userId}}); const now=new Date(); const editedAt=new Date(Math.min(now.getTime(),new Date(candidate.editedAt).getTime()));
   const existing=await tx.record.findUnique({where:{userId_id:{userId,id:candidate.id}}});
   if(existing){
    const incomingWins=editedAt>existing.editedAt || (editedAt.getTime()===existing.editedAt.getTime() && deviceId>existing.editedBy);
    if(!incomingWins)return {row:existing,stale:true};
   }
   const parent=candidate.collectionId?await tx.record.findUnique({where:{userId_id:{userId,id:candidate.collectionId}}}):null;
   if(parent?.isDeleted&&!candidate.isDeleted){
    if(existing)return {row:existing,stale:true};
    return {rejected:{id:candidate.id,type:candidate.type,code:'COLLECTION_DELETED'}};
   }
   if(candidate.type==='resource'&&!candidate.isDeleted&&user.tier==='free'&&(!existing||existing.isDeleted)){
    const active=await tx.record.count({where:{userId,type:'resource',isDeleted:false}});
    if(active>=config.freeTabLimit){
     await tx.limitHit.create({data:{userId,itemId:candidate.id}});
     return {rejected:{id:candidate.id,type:candidate.type,code:'LIMIT_REACHED',limit:config.freeTabLimit}};
    }
   }
   const bumped=await tx.user.update({where:{id:userId},data:{nextServerVersion:{increment:1}},select:{nextServerVersion:true}});
   const row=await tx.record.upsert({where:{userId_id:{userId,id:candidate.id}},create:{userId,id:candidate.id,type:candidate.type,content:json(candidate.content),collectionId:candidate.collectionId,isDeleted:candidate.isDeleted,editedAt,editedBy:deviceId,serverVersion:bumped.nextServerVersion},update:{type:candidate.type,content:json(candidate.content),collectionId:candidate.collectionId,isDeleted:candidate.isDeleted,editedAt,editedBy:deviceId,serverVersion:bumped.nextServerVersion}});
   if(candidate.type==='collection'&&candidate.isDeleted){
    const children=await tx.record.findMany({where:{userId,collectionId:candidate.id,isDeleted:false}});
    for(const child of children){const version=await tx.user.update({where:{id:userId},data:{nextServerVersion:{increment:1}},select:{nextServerVersion:true}});await tx.record.update({where:{userId_id:{userId,id:child.id}},data:{isDeleted:true,deletedByCollectionId:candidate.id,editedAt,editedBy:deviceId,serverVersion:version.nextServerVersion}});}
   }else if(candidate.type==='collection'&&!candidate.isDeleted&&existing?.isDeleted){
    const children=await tx.record.findMany({where:{userId,deletedByCollectionId:candidate.id,isDeleted:true}});
    for(const child of children){const version=await tx.user.update({where:{id:userId},data:{nextServerVersion:{increment:1}},select:{nextServerVersion:true}});await tx.record.update({where:{userId_id:{userId,id:child.id}},data:{isDeleted:false,deletedByCollectionId:null,editedAt,editedBy:deviceId,serverVersion:version.nextServerVersion}});}
   }
   return {row};
  });
  if('rejected'in result)rejected.push(result.rejected);else authoritative.push(wire(result.row));
 }
 await prisma.device.update({where:{userId_id:{userId,id:deviceId}},data:{lastSyncAt:new Date()}}); return {authoritative,rejected};
}

export async function pull(userId:string,deviceId:string,cursor:bigint,limit=200,checkHorizon=true){
 const safeCursor=cursor<0n?0n:cursor; const safeLimit=Math.max(1,Math.min(200,Math.trunc(limit)));
 const user=await prisma.user.findUniqueOrThrow({where:{id:userId}}); const fullResync=checkHorizon&&safeCursor<user.purgeHorizon; const effective=fullResync?0n:safeCursor;
 const rows=await prisma.record.findMany({where:{userId,serverVersion:{gt:effective}},orderBy:{serverVersion:'asc'},take:safeLimit});
 const next=rows.length?rows[rows.length-1].serverVersion:effective; const hasMore=await prisma.record.count({where:{userId,serverVersion:{gt:next}}})>0;
 await prisma.device.update({where:{userId_id:{userId,id:deviceId}},data:{lastSyncAt:new Date(),lastServerVersion:next}});
 return {records:rows.map(wire),cursor:next.toString(),hasMore,fullResync,purgeHorizon:user.purgeHorizon.toString()};
}

export async function purgeTombstones(){const cutoff=new Date(Date.now()-config.retentionDays*86400000);const users=await prisma.user.findMany({select:{id:true}});for(const user of users)await prisma.$transaction(async tx=>{const rows=await tx.record.findMany({where:{userId:user.id,isDeleted:true,editedAt:{lt:cutoff}},select:{serverVersion:true}});if(!rows.length)return;const horizon=rows.reduce((max,row)=>row.serverVersion>max?row.serverVersion:max,0n);await tx.record.deleteMany({where:{userId:user.id,isDeleted:true,editedAt:{lt:cutoff}}});await tx.user.update({where:{id:user.id},data:{purgeHorizon:horizon}});});}
