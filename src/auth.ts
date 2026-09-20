import jwt from 'jsonwebtoken'; import bcrypt from 'bcryptjs'; import { config } from './config.js';
export type Claims={userId:string;deviceId:string};
export const accessToken=(claims:Claims)=>jwt.sign(claims,config.accessSecret,{expiresIn:`${config.accessMinutes}m`});
export const refreshToken=(claims:Claims)=>jwt.sign(claims,config.refreshSecret,{expiresIn:`${config.refreshDays}d`});
export const verifyAccess=(token:string)=>jwt.verify(token,config.accessSecret) as Claims;
export const verifyRefresh=(token:string)=>jwt.verify(token,config.refreshSecret) as Claims;
export const hashToken=(token:string)=>bcrypt.hash(token,12);
export const matchesToken=(token:string,hash:string)=>bcrypt.compare(token,hash);
