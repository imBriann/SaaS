import { z } from 'zod';
import type { Tx } from '../db/index.js';
import { requirePerm, requireWritable, type Ctx } from '../core/context.js';
import { audit } from '../core/audit.js';
import { AppError, invalid } from '../lib/errors.js';
import { uuidv7 } from '../lib/util.js';
import { aPesos } from '../lib/money.js';
import { rangoDia } from '../lib/time.js';
import { zonaDe } from '../core/tenant.js';

export const BASE_COMISION='Venta confirmada y totalmente pagada; base sin IVA después de descuentos. Se excluyen ventas anuladas y ventas con nota de crédito. No incluye pagos pendientes. Las reglas se fijan al registrar cada venta y no cambian retroactivamente.';
const Schema=z.object({activo:z.boolean(),informes:z.boolean(),frecuencia:z.enum(['diaria','semanal','quincenal','mensual']),version:z.number().int().nonnegative(),confirmar:z.literal(true),reglas:z.array(z.object({user_id:z.uuid(),product_id:z.uuid().nullable(),porcentaje:z.number().min(0).max(100).multipleOf(0.01)})).max(200)});
export async function settings(tx:Tx,ctx:Ctx){
 requirePerm(ctx,'user:manage');
 const s=(await tx.query('SELECT * FROM commission_settings WHERE tenant_id=$1',[ctx.tenantId])).rows[0];
 const historial=(await tx.query("SELECT creado_en,actor_nombre,detalle FROM audit_event WHERE accion='comisiones.configurar' ORDER BY creado_en DESC LIMIT 30")).rows;
 return {config:s??{activo:false,informes:false,frecuencia:'mensual',reglas:[],version:0},base:BASE_COMISION,historial};
}
export async function save(tx:Tx,ctx:Ctx,body:unknown){
 requirePerm(ctx,'user:manage');requireWritable(ctx);
 const d=Schema.parse(body);
 if(d.activo&&!(await tx.query("SELECT 1 FROM tenant_module WHERE modulo='comisiones' AND activo")).rows.length)throw invalid('Activa el módulo de comisiones antes de configurar porcentajes.');
 await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`commission:${ctx.tenantId}`]);
 const old=(await tx.query('SELECT * FROM commission_settings WHERE tenant_id=$1 FOR UPDATE',[ctx.tenantId])).rows[0];
 if((old?.version??0)!==d.version)throw new AppError('CONFLICT','Otra persona cambió las reglas. Recarga antes de guardar.');
 const seen=new Set<string>();
 for(const r of d.reglas){const k=r.user_id+':'+r.product_id;if(seen.has(k))throw invalid('Repite una sola regla por persona y servicio.');seen.add(k);
 if(!(await tx.query('SELECT 1 FROM user_tenant WHERE user_id=$1 AND activo',[r.user_id])).rows.length)throw invalid('La persona no está activa en tu empresa.');
 if(r.product_id&&!(await tx.query("SELECT 1 FROM product WHERE id=$1 AND tipo='SERVICIO' AND eliminado_en IS NULL",[r.product_id])).rows.length)throw invalid('El servicio no pertenece a tu catálogo.');
 }
 await tx.query(`INSERT INTO commission_settings(tenant_id,activo,informes,frecuencia,reglas,version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id) DO UPDATE SET activo=EXCLUDED.activo,informes=EXCLUDED.informes,frecuencia=EXCLUDED.frecuencia,reglas=EXCLUDED.reglas,version=EXCLUDED.version`,[ctx.tenantId,d.activo,d.informes,d.frecuencia,JSON.stringify(d.reglas),d.version+1]);
 await audit(tx,ctx,{accion:'comisiones.configurar',recurso:'commission_settings',resultado:'EXITO',detalle:{antes:old??null,despues:d,base:BASE_COMISION}});
 return settings(tx,ctx);
}
export async function eligible(tx:Tx,ctx:Ctx){
 requirePerm(ctx,'order:create');
 return (await tx.query('SELECT ut.user_id AS id,coalesce(ut.nombre_visible,u.nombre) AS nombre FROM user_tenant ut JOIN users u ON u.id=ut.user_id WHERE ut.activo ORDER BY nombre')).rows;
}
/** Frozen per-sale rates; no employee information is added to fiscal payloads. */
export async function record(tx:Tx,ctx:Ctx,orderId:string,userId:string|null|undefined,lines:{product_id:string;base:number}[]){
 if(!userId)return;
 if(!(await tx.query('SELECT 1 FROM user_tenant WHERE user_id=$1 AND activo',[userId])).rows.length)throw invalid('La persona responsable no está activa en esta empresa.');
 const s=(await tx.query("SELECT c.* FROM commission_settings c JOIN tenant_module m ON m.tenant_id=c.tenant_id AND m.modulo='comisiones' AND m.activo WHERE c.activo")).rows[0];
 if(!s)return;
 for(const l of lines){const rule=s.reglas.find((r:any)=>r.user_id===userId&&r.product_id===l.product_id)??s.reglas.find((r:any)=>r.user_id===userId&&!r.product_id);if(!rule)continue;
 const amount=Math.round(l.base*rule.porcentaje/100);
 await tx.query('INSERT INTO commission_entry(id,tenant_id,order_id,user_id,product_id,base,porcentaje,comision,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[uuidv7(),ctx.tenantId,orderId,userId,l.product_id,aPesos(l.base),rule.porcentaje,aPesos(amount),s.version]);
 }
}
export async function report(tx:Tx,ctx:Ctx,date:unknown){
 requirePerm(ctx,'user:manage');
 const s=(await tx.query('SELECT * FROM commission_settings WHERE tenant_id=$1',[ctx.tenantId])).rows[0];
 if(!s?.informes)throw invalid('Activa los informes de comisiones para consultarlos.');
 const v=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(date);let start=new Date(v+'T12:00:00Z');if(Number.isNaN(start.getTime())||start.toISOString().slice(0,10)!==v)throw invalid('La fecha no existe.');
 if(s.frecuencia==='semanal')start.setUTCDate(start.getUTCDate()-((start.getUTCDay()+6)%7));
 if(s.frecuencia==='mensual')start.setUTCDate(1);
 if(s.frecuencia==='quincenal')start.setUTCDate(start.getUTCDate()<16?1:16);
 const end=new Date(start);if(s.frecuencia==='mensual')end.setUTCMonth(end.getUTCMonth()+1);else if(s.frecuencia==='quincenal'){if(start.getUTCDate()===1)end.setUTCDate(16);else{end.setUTCMonth(end.getUTCMonth()+1);end.setUTCDate(1);}}else end.setUTCDate(end.getUTCDate()+(s.frecuencia==='semanal'?7:1));
 const desde=start.toISOString().slice(0,10),hasta=end.toISOString().slice(0,10),zona=await zonaDe(tx);
 const a=rangoDia(desde,zona).desde,b=rangoDia(hasta,zona).desde;
 const filas=(await tx.query(`SELECT e.*,o.numero,coalesce(ut.nombre_visible,u.nombre) AS persona,p.nombre AS servicio FROM commission_entry e JOIN "order" o ON o.id=e.order_id JOIN users u ON u.id=e.user_id LEFT JOIN user_tenant ut ON ut.user_id=e.user_id AND ut.tenant_id=e.tenant_id JOIN product p ON p.id=e.product_id WHERE o.estado='CONFIRMADA' AND o.estado_pago='PAGADA' AND o.eliminado_en IS NULL AND o.creado_en >= $1 AND o.creado_en < $2 AND NOT EXISTS(SELECT 1 FROM fiscal_document f WHERE f.order_id=o.id AND f.tipo='NOTA_CREDITO') ORDER BY o.creado_en,o.numero`,[a,b])).rows;
 return {desde,hasta_exclusivo:hasta,frecuencia:s.frecuencia,base:BASE_COMISION,criterio_periodo:'Fecha de registro de la venta; el estado de pago se consulta al generar el informe.',filas,total:Math.round(filas.reduce((n,f)=>n+Number(f.comision),0)*100)/100};
}
