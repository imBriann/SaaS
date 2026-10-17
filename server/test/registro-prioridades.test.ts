import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import ExcelJS from 'exceljs';
import { setup,verificarAlta,codigoDelCorreo,login,api,CRED,type Env } from './helpers.js';
import { classifyBusiness } from '../src/onboarding/classifier.js';
import { SinModelo,setLlm } from '../src/ai/llm/index.js';
import { applyMapping,inferMapping,readSheet } from '../src/onboarding/importer.js';
import { todayLocal } from '../src/lib/time.js';
let E:Env;let admin:ReturnType<typeof api>;
beforeAll(async()=>{E=await setup();admin=api(E.app,await login(E.app,...CRED.admin),'elparche');});
afterAll(async()=>{setLlm(null);await E.app.close();await E.db.close();});
const post=(url:string,payload:any={})=>E.app.inject({method:'POST',url,payload});
const patch=(tk:string,payload:any)=>E.app.inject({method:'PATCH',url:`/api/onboarding/borradores/${tk}`,payload});
const get=(tk:string)=>E.app.inject({method:'GET',url:`/api/onboarding/borradores/${tk}`});
async function draft(slug:string){const d=(await post('/api/onboarding/borradores',{descripcion:'Tengo una tienda de ropa y vendo accesorios.'})).json();const r=await patch(d.token,{negocio:{nombre:'Negocio '+slug,slug,email:slug+'@registro.test'}});expect(r.statusCode,r.body).toBe(200);return d.token;}
describe('Registro: datos verificables y prioridad humana',()=>{
 it('no inventa tamaño, volumen, necesidad fiscal ni clasificación ambigua',async()=>{
  const c=await classifyBusiness('Estoy pensando en abrir un negocio próximamente.');
  expect(c).toMatchObject({sector:null,tamano:null,volumen_conv_mes:null,factura_electronica:null});
  const neg=await classifyBusiness('Tengo una barbería y no necesito facturación electrónica.');
  expect(neg.sector).toBe('barberia');expect(neg.factura_electronica).toBe(false);
  // Un comercio con dos actividades: la primera es la principal y la otra queda como adicional, sin adivinar ni descartar.
  const mixto=await classifyBusiness('Tengo una cafetería y una veterinaria.');
  expect(mixto).toMatchObject({sector:'restaurante',tipo_negocio:'Cafetería'});expect(mixto.actividades_adicionales).toEqual([{sector:'mascotas',tipo_negocio:'Veterinaria',evidencia:'veterinaria'}]);
  const cafeSpa=await classifyBusiness('Tengo un café spa en Cúcuta con tres empleados.');
  expect(cafeSpa).toMatchObject({sector:'restaurante',tipo_negocio:'Cafetería'});expect(cafeSpa.actividades_adicionales?.map(a=>a.tipo_negocio)).toEqual(['Spa']);expect(cafeSpa.modulos_sugeridos).toEqual(expect.arrayContaining(['agenda','inventario']));
  expect((await classifyBusiness('Tengo una barbería')).actividades_adicionales).toEqual([]);
 });
 it('catálogo amplio, tipos válidos y reanálisis que conserva las respuestas y el borrador',async()=>{
  const catalog=(await E.app.inject({method:'GET',url:'/api/onboarding/catalogos'})).json();expect(catalog.sectores.length).toBeGreaterThanOrEqual(19);
  const tk=await draft('prioridad');
  await patch(tk,{clasificacion:{sector:'salud',tipo_negocio:'Odontología',tamano:'unipersonal'}});
  expect((await patch(tk,{clasificacion:{tipo_negocio:'Barbería'}})).statusCode).toBe(400);
  const re=(await post(`/api/onboarding/borradores/${tk}/analizar`,{descripcion:'Tengo una barbería con tres barberos y 20 conversaciones al día.'})).json();
  expect(re.token).toBe(tk);expect(re.negocio.nombre).toBe('Negocio prioridad');expect(re.clasificacion.sector).toBe('salud');expect(re.clasificacion.tipo_negocio).toBe('Odontología');expect(re.clasificacion.tamano).toBe('unipersonal');expect(re.clasificacion.conflictos.length).toBeGreaterThan(0);
  const changed=(await patch(tk,{clasificacion:{sector:'tecnologia'}})).json();expect(changed.clasificacion.tipo_negocio).toBeNull();
 });
 it('códigos: no crea usuarios, espera real, errores, expiración, confirmación y cambio de correo',async()=>{
  const tk=await draft('verifica');const count=()=>E.db.withPlatform(async tx=>(await tx.query('SELECT count(*)::int AS n FROM users')).rows[0].n);const before=await count();
  const payment=await post(`/api/onboarding/borradores/${tk}/pago`);expect(payment.statusCode).toBe(400);expect(payment.json().error.details.faltan).toContain('correo_verificado');
  const first=await post(`/api/onboarding/borradores/${tk}/correo/enviar`);expect(first.statusCode).toBe(200);expect(first.body).not.toContain('codigo');
  expect((await post(`/api/onboarding/borradores/${tk}/correo/enviar`)).statusCode).toBe(429);
  const code=await codigoDelCorreo(E.db,'verifica@registro.test');
  expect((await post(`/api/onboarding/borradores/${tk}/correo/verificar`,{codigo:code==='000000'?'111111':'000000'})).statusCode).toBe(400);
  expect((await get(tk)).json().correo_verificado).toBe(false);
  await E.db.withPlatform(tx=>tx.query("UPDATE onboarding_email_code SET expira_en=now()-interval '1 second' WHERE draft_token=$1",[tk]));
  expect((await post(`/api/onboarding/borradores/${tk}/correo/verificar`,{codigo:code})).json().error.message).toMatch(/expiró/);
  await E.db.withPlatform(tx=>tx.query("UPDATE onboarding_email_code SET creado_en=now()-interval '61 seconds' WHERE draft_token=$1",[tk]));
  await verificarAlta(E,tk);expect((await get(tk)).json().correo_verificado).toBe(true);expect(await count()).toBe(before);
  await patch(tk,{negocio:{email:'corregido@registro.test'}});expect((await get(tk)).json().correo_verificado).toBe(false);
 });
 it('teléfono internacional, NIT numérico, geografía y logotipo se validan en servidor',async()=>{
  const tk=await draft('formatos');
  const r=await patch(tk,{negocio:{telefono_pais:'CO',telefono_nacional:'300 123 4567',pais:'CO',departamento:'54',municipio:'54001',direccion:'Calle 5 # 2-10'}});
  expect(r.statusCode,r.body).toBe(200);expect(r.json().negocio.telefono).toBe('+573001234567');expect(r.json().negocio.direccion_estado).toBe('PENDIENTE_CONFIRMAR');
  expect((await patch(tk,{negocio:{telefono_pais:'CO',telefono_nacional:'12'}})).statusCode).toBe(400);
  expect((await patch(tk,{negocio:{nit:'901.123-4'}})).statusCode).toBe(400);
  expect((await patch(tk,{negocio:{departamento:'05',municipio:'54001'}})).statusCode).toBe(400);
  expect((await patch(tk,{logo_data_url:'data:image/png;base64,YmFk'})).statusCode).toBe(400);
  const states=(await E.app.inject({method:'GET',url:'/api/onboarding/territorios?pais=CO'})).json();expect(states).toHaveLength(33);
 });
 it('ocupado y reservado; concurrencia de checkout conserva una sola reserva; expiración libera el nombre',async()=>{
  expect((await E.app.inject({method:'GET',url:'/api/onboarding/subdominio?slug=admin'})).json().valido).toBe(false);
  const taken=(await E.app.inject({method:'GET',url:'/api/onboarding/subdominio?slug=elparche'})).json();expect(taken.disponible).toBe(false);expect(taken.alternativas.length).toBeGreaterThan(0);
  const a=await draft('competencia-a'),b=await draft('competencia-b');await patch(a,{negocio:{slug:'misma-direccion'}});await patch(b,{negocio:{slug:'misma-direccion'}});await verificarAlta(E,a);await verificarAlta(E,b);
  const results=await Promise.all([post(`/api/onboarding/borradores/${a}/pago`),post(`/api/onboarding/borradores/${b}/pago`)]);expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);
  await E.db.withPlatform(tx=>tx.query("UPDATE subdomain_reservation SET expira_en=now()-interval '1 second' WHERE slug='misma-direccion'"));
  expect((await E.app.inject({method:'GET',url:'/api/onboarding/subdominio?slug=misma-direccion'})).json().disponible).toBe(true);
 });
});
describe('Importación real y reintentos',()=>{
 it('lee XLSX, elige hoja, preserva filas y funciona sin proveedor IA',async()=>{
  const wb=new ExcelJS.Workbook();wb.addWorksheet('Notas').addRow(['Solo notas']);const ws=wb.addWorksheet('Productos');ws.addRows([['Artículo','Tarifa','Existencias'],['Producto real',15000,3],['Precio inválido','abc',2],['Producto real',15000,3]]);
  const h=await readSheet(Buffer.from(await wb.xlsx.writeBuffer()),'datos.xlsx','Productos');expect(h.hojas).toEqual(['Notas','Productos']);
  setLlm(new SinModelo());const {mapeo}=await inferMapping(h);setLlm(null);const rows=applyMapping(h,[...mapeo].reverse());expect(rows).toHaveLength(3);expect(rows[0].precio).toBe(15000);expect(rows[1].estado).toBe('REVISAR');expect(rows[2].problemas).toContain('Duplicado en el archivo');
  await expect(readSheet(Buffer.alloc(0),'empty.csv')).rejects.toThrow();await expect(readSheet(Buffer.from('broken'),'bad.xlsx')).rejects.toThrow();await expect(readSheet(Buffer.from('Nombre,Precio\n"sin cierre,100'),'bad.csv')).rejects.toThrow();
 });
 it('persiste válidos con reporte por fila, no duplica al reintentar y aísla empresas',async()=>{
  const body={duplicados:'omitir',filas:[{fila:2,nombre:'Registro integrado',tipo:'PRODUCTO',precio:15000,sku:'INT-001',stock:2},{fila:3,nombre:'Inválido',tipo:'PRODUCTO',precio:-1},{fila:4,nombre:'Registro integrado',tipo:'PRODUCTO',precio:15000,sku:'INT-001'}]};
  const r=await admin.post('/productos/importar/confirmar',body);expect(r.status).toBe(200);expect(r.body).toMatchObject({creados:1,omitidos:1,rechazados:1});expect(r.body.reporte).toHaveLength(3);
  expect((await admin.get('/productos')).body.filter((p:any)=>p.sku==='INT-001')).toHaveLength(1);
  const again=await admin.post('/productos/importar/confirmar',body);expect(again.body.creados).toBe(0);
  expect(await E.db.withTenant(E.B,async tx=>(await tx.query("SELECT id FROM product WHERE sku='INT-001'")).rows.length)).toBe(0);
 });
 it('confirmación del borrador informa cero escritos y persiste tras pago en el módulo correcto',async()=>{
  const tk=await draft('importado-real');const endpoint=`/api/onboarding/borradores/${tk}/catalogo/confirmar`;
  const body={origen:'manual',duplicados:'omitir',filas:[{nombre:'Servicio importado',tipo:'SERVICIO',precio:25000,sku:'ALTA-1'}]};
  expect((await post(endpoint,body)).json().resumen.importados).toBe(1);expect((await post(endpoint,body)).json().resumen.importados).toBe(0);
  await verificarAlta(E,tk);const p=await post(`/api/onboarding/borradores/${tk}/pago`);expect(p.statusCode,p.body).toBe(200);
  await post('/api/pasarela/simular',{ref:p.json().referencia,entregas:3});
  await post(`/api/onboarding/borradores/${tk}/contrasena`,{password:'registro-prueba-2026'});
  const cookie=await login(E.app,'importado-real@registro.test','registro-prueba-2026');const T=api(E.app,cookie,'importado-real');const products=(await T.get('/productos')).body;expect(products).toHaveLength(1);expect(products[0].sku).toBe('ALTA-1');const recursos=(await T.get('/agenda/recursos')).body;expect(recursos.map((r:any)=>r.nombre)).toEqual(['Agenda principal']);
 });
});
describe('Comisiones con ventas reales',()=>{
 it('control de versiones, base neta, pagos pendientes, historial, cambios no retroactivos y aislamiento',async()=>{
  const personas=(await admin.get('/equipo/responsables')).body;const user=personas[0].id;const products=(await admin.get('/productos')).body;const product=products.find((p:any)=>p.nombre==='Corte clásico');
  const cliente=(await admin.get('/clientes')).body.clientes[0];
  const rule={activo:true,informes:true,frecuencia:'mensual',version:0,confirmar:true,reglas:[{user_id:user,product_id:null,porcentaje:10}]};
  expect((await admin.patch('/equipo/comisiones',rule)).status).toBe(200);
  expect((await admin.patch('/equipo/comisiones',rule)).status).toBe(409);
  const sale=(await admin.post('/ventas',{customer_id:cliente.id,responsable_id:user,items:[{product_id:product.id,cantidad:1,descuento_pct:10}]})).body;
  let r=(await admin.get('/equipo/comisiones/informe?fecha='+todayLocal())).body;expect(r.filas).toHaveLength(0);
  await E.db.withTenant(E.A,tx=>tx.query("UPDATE \"order\" SET estado_pago='PAGADA' WHERE id=$1",[sale.id]));
  r=(await admin.get('/equipo/comisiones/informe?fecha='+todayLocal())).body;
  const base=Math.round(Number(product.precio)*100*0.9/(1+Number(product.iva_pct)/100))/100;
  expect(Number(r.filas[0].base)).toBe(base);expect(Number(r.filas[0].comision)).toBe(Math.round(base*10)/100);
  await admin.patch('/equipo/comisiones',{...rule,version:1,reglas:[{user_id:user,product_id:null,porcentaje:20}]});
  expect((await admin.get('/equipo/comisiones/informe?fecha='+todayLocal())).body.total).toBe(r.total);
  expect((await admin.get('/equipo/comisiones')).body.historial).toHaveLength(2);
  expect(await E.db.withTenant(E.B,async tx=>(await tx.query('SELECT * FROM commission_entry')).rows.length)).toBe(0);
  await E.db.withTenant(E.A,tx=>tx.query("UPDATE \"order\" SET estado='ANULADA' WHERE id=$1",[sale.id]));
  expect((await admin.get('/equipo/comisiones/informe?fecha='+todayLocal())).body.total).toBe(0);
 });
});
