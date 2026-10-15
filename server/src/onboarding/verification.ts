import { randomInt } from 'node:crypto';
import type { Database } from '../db/index.js';
import { config } from '../config.js';
import { hmacHex, safeEqual, uuidv7 } from '../lib/util.js';
import { hashIp } from '../modules/otp.js';
import { encolarCorreo } from '../email/servicio.js';
import { codigoVerificacion } from '../email/plantillas.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
const hash = (id: string, code: string) => hmacHex(config.appKey, `alta:${id}:${code}`);
export async function sendDraftCode(db: Database, tk: string, ip: string) {
 return db.withPlatform(async tx => {
  const d = (await tx.query('SELECT * FROM onboarding_draft WHERE token=$1 FOR UPDATE', [tk])).rows[0];
  if (!d) throw notFound();
  if (d.estado !== 'BORRADOR') throw invalid('El registro ya está en proceso de pago.');
  const email = d.negocio.email;
  if (!email) throw invalid('Guarda primero el correo del administrador.');
  // Serialize per IP too, so parallel drafts cannot bypass the global limit.
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [hashIp(ip)]);
  const uso = (await tx.query(`SELECT max(creado_en) FILTER (WHERE draft_token=$1 OR email=$3) AS ultimo,
    count(*) FILTER (WHERE creado_en > now()-interval '1 hour' AND (draft_token=$1 OR email=$3))::int AS hora,
    count(*) FILTER (WHERE creado_en > now()-interval '1 hour' AND ip_hash=$2)::int AS ip FROM onboarding_email_code`, [tk, hashIp(ip), email])).rows[0];
  const espera = uso.ultimo ? Math.max(0, 60 - Math.floor((Date.now()-new Date(uso.ultimo).getTime())/1000)) : 0;
  if (espera) throw new AppError('QUOTA', `Espera ${espera} segundos antes de reenviar.`, { espera_segundos: espera });
  if (uso.hora >= 5 || uso.ip >= 20) throw new AppError('QUOTA', 'Alcanzaste el límite de códigos. Intenta en una hora.');
  await tx.query('UPDATE onboarding_email_code SET invalidado_en=now() WHERE draft_token=$1 AND usado_en IS NULL', [tk]);
  const id = uuidv7(), codigo = String(randomInt(0,1000000)).padStart(6,'0');
  const minutos = config.correo.otpMinutos;
  const caduca = new Date(Date.now()+minutos*60000);
  await tx.query('INSERT INTO onboarding_email_code(id,draft_token,email,codigo_hash,ip_hash,expira_en) VALUES ($1,$2,$3,$4,$5,$6)', [id,tk,email,hash(id,codigo),hashIp(ip),caduca]);
  await encolarCorreo(tx, { tenantId: null, para: email, sensible: true, caducaEn: caduca, clave: `alta:${id}`, correo: codigoVerificacion({ nombre: d.negocio.responsable || d.negocio.nombre || 'Hola', codigo, minutos }) });
  return { ok: true, espera_segundos: 60, minutos, email, estado: 'ENCOLADO' };
 });
}
export async function verifyDraftCode(db: Database, tk: string, code: unknown) {
 if (!/^\d{6}$/.test(String(code))) throw invalid('Escribe los seis dígitos del código.');
 const r = await db.withPlatform(async tx => {
  const d = (await tx.query('SELECT * FROM onboarding_draft WHERE token=$1 FOR UPDATE', [tk])).rows[0];
  if (!d) throw notFound();
  const c = (await tx.query(`SELECT * FROM onboarding_email_code WHERE draft_token=$1 AND email=$2 AND usado_en IS NULL AND invalidado_en IS NULL ORDER BY creado_en DESC LIMIT 1 FOR UPDATE`, [tk,d.negocio.email])).rows[0];
  if (!c || new Date(c.expira_en) <= new Date()) return 'El código expiró o ya no está vigente. Solicita otro.';
  if (!safeEqual(hash(c.id,String(code)),c.codigo_hash)) {
   await tx.query('UPDATE onboarding_email_code SET intentos=intentos+1, invalidado_en=CASE WHEN intentos>=4 THEN now() ELSE NULL END WHERE id=$1',[c.id]);
   return c.intentos>=4 ? 'Se agotaron los intentos. Solicita otro código.' : 'El código no es válido. Revisa los seis dígitos.';
  }
  await tx.query('UPDATE onboarding_email_code SET usado_en=now() WHERE id=$1',[c.id]);
  await tx.query('UPDATE onboarding_draft SET email_verificado=$2,email_verificado_en=now() WHERE token=$1',[tk,c.email]);
  return null;
 });
 if(r) throw invalid(r);
 return { ok:true };
}
