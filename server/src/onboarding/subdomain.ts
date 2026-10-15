import type { Database, Tx } from '../db/index.js';
import { config } from '../config.js';
import { AppError, invalid } from '../lib/errors.js';
const reserved = new Set(['www','app','api','admin','plataforma','mail','soporte','omnegia','ayuda','correo','status','static','cdn','assets','localhost','root','billing','test','dev','staging','operador','empezar','entrar']);
export function validSlug(s: string) { return /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(s) && !reserved.has(s); }
export function domainInfo() {
 const local = config.baseDomain === 'localhost';
 return { dominio: local && !config.dev ? null : config.baseDomain, local: local && config.dev, url_local: config.dev ? config.publicUrl : null };
}
async function occupied(tx: Tx, slug: string, tk: string) {
 return (await tx.query(`SELECT 1 FROM tenant WHERE slug=$1 UNION ALL SELECT 1 FROM subdomain_reservation WHERE slug=$1 AND draft_token<>$2 AND expira_en>now() LIMIT 1`,[slug,tk])).rows.length>0;
}
export async function availability(db: Database, slug: string, tk='') {
 return db.withPlatform(async tx => {
  const valido=validSlug(slug), disponible=valido && !(await occupied(tx,slug,tk));
  const alternativas:string[]=[];
  if(valido&&!disponible) for(let i=2;i<12&&alternativas.length<3;i++) { const s=`${slug.slice(0,36)}-${i}`; if(!await occupied(tx,s,tk)) alternativas.push(s); }
  return { valido, disponible, alternativas, ...domainInfo() };
 });
}
export async function reserveSlug(tx: Tx, slug: string, tk: string, minutes: number) {
 if (!validSlug(slug)) throw invalid('Usa entre 3 y 40 letras minúsculas, números o guiones interiores; este nombre puede estar reservado.');
 await tx.query('DELETE FROM subdomain_reservation WHERE expira_en<=now()');
 if(await occupied(tx,slug,tk)) throw new AppError('CONFLICT','Ese subdominio ya está ocupado. Regresa a los datos y elige una alternativa.');
 const r=await tx.query(`INSERT INTO subdomain_reservation(slug,draft_token,expira_en) VALUES($1,$2,now()+($3||' minutes')::interval)
 ON CONFLICT(slug) DO UPDATE SET expira_en=EXCLUDED.expira_en WHERE subdomain_reservation.draft_token=EXCLUDED.draft_token RETURNING slug`,[slug,tk,String(minutes)]);
 if(!r.rows.length) throw new AppError('CONFLICT','Otra persona acaba de elegir este subdominio. Selecciona otro.');
}
