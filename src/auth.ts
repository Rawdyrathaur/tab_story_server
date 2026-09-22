import jwt from 'jsonwebtoken'; import bcrypt from 'bcryptjs'; import { z } from 'zod'; import { config } from './config.js';
export type Claims={userId:string;deviceId:string};
const claimsSchema=z.object({userId:z.string().uuid(),deviceId:z.string().min(1).max(128)});
export const accessToken=(claims:Claims)=>jwt.sign(claims,config.accessSecret,{expiresIn:`${config.accessMinutes}m`});
export const refreshToken=(claims:Claims)=>jwt.sign(claims,config.refreshSecret,{expiresIn:`${config.refreshDays}d`});
export const verifyAccess=(token:string)=>claimsSchema.parse(jwt.verify(token,config.accessSecret)) as Claims;
export const verifyRefresh=(token:string)=>claimsSchema.parse(jwt.verify(token,config.refreshSecret)) as Claims;
export const hashToken=(token:string)=>bcrypt.hash(token,12);
export const matchesToken=(token:string,hash:string)=>bcrypt.compare(token,hash);
