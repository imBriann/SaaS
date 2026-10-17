import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../../db/index.js';
import { AppError, notFound } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/util.js';
import { loadUser } from '../context.js';
import * as op from '../../modules/operador.js';
import * as reembolsos from '../../modules/reembolsos.js';

/**
 * Rutas del panel interno de Omnegia (/api/operador/*).
 *
 * Exigen una sesión de una persona con rol de plataforma abierta con segundo
 * factor. Cualquier otra sesión recibe «no encontrado» (no se revela que la ruta
 * existe) y el intento queda en la auditoría del operador. Ninguna de estas rutas
 * fija contexto de empresa: no pueden leer datos operativos de los negocios.
 */
export async function registerOperatorRoutes(app: FastifyInstance, db: Database) {
  const guard = async (req: FastifyRequest) => {
    const user = req.user ?? (await loadUser(db, req));
    if (!user?.rol_plataforma || !user.segundo_factor) {
      if (user) {
        await db.withPlatform((tx) => tx.query(
          `INSERT INTO auditoria_plataforma (id, actor_id, actor_email, accion, recurso, resultado, correlacion, detalle) VALUES ($1,$2,$3,'operador.acceso_denegado','ruta','DENEGADO',$4,$5)`,
          [uuidv7(), user.id, user.email, req.correlacion, JSON.stringify({ ruta: req.routeOptions?.url ?? '', metodo: req.method, motivo: user.rol_plataforma ? 'sin_segundo_factor' : 'sin_rol' })])).catch(() => {});
      }
      throw notFound();
    }
    req.user = user;
  };
  type H = (o: op.Operador, req: FastifyRequest & { params: any; query: any; body: any }, reply: FastifyReply) => Promise<unknown>;
  const r = (method: 'GET' | 'POST' | 'PATCH', url: string, h: H) =>
    app.route({ method, url: `/api/operador${url}`, preHandler: guard, handler: (req, reply) => h({ user: req.user!, correlacion: req.correlacion }, req as any, reply) });

  r('GET', '/yo', async (o) => ({ id: o.user.id, nombre: o.user.nombre, email: o.user.email, rol: o.user.rol_plataforma, permisos: op.PERMISOS_OPERADOR[o.user.rol_plataforma!] }));
  r('GET', '/resumen', (o, req) => op.resumen(db, o, req.query));

  r('GET', '/empresas', (o, req) => op.listarEmpresas(db, o, req.query));
  r('GET', '/empresas.csv', async (o, _req, reply) => {
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="empresas.csv"');
    return op.exportarEmpresas(db, o);
  });
  r('GET', '/empresas/:id', (o, req) => op.verEmpresa(db, o, req.params.id));
  r('POST', '/empresas/:id/estado', (o, req) => op.cambiarEstado(db, o, req.params.id, req.body));
  r('POST', '/empresas/:id/plan', (o, req) => op.cambiarPlan(db, o, req.params.id, req.body));
  r('POST', '/empresas/:id/modulos', (o, req) => op.cambiarModulo(db, o, req.params.id, req.body));

  r('GET', '/suscripciones', (o, req) => op.suscripciones(db, o, req.query));
  r('PATCH', '/planes/:codigo', (o, req) => op.editarPlan(db, o, String(req.params.codigo), req.body));

  r('GET', '/salud', (o, req) => op.salud(db, o, req.query));
  r('POST', '/trabajos/:id/reintentar', (o, req) => op.reintentarTrabajo(db, o, req.params.id, req.body?.motivo));

  r('GET', '/incidentes', (o, req) => op.listarIncidentes(db, o, req.query));
  r('PATCH', '/incidentes/:id', (o, req) => op.actualizarIncidente(db, o, req.params.id, req.body));
  r('POST', '/incidentes/:id/reintentar', (o, req) => op.reintentarIncidente(db, o, req.params.id, req.body?.motivo));

  r('GET', '/integraciones', (o) => op.estadoIntegraciones(db, o));

  r('GET', '/soporte', (o, req) => op.listarTickets(db, o, req.query));
  r('GET', '/soporte/:id', (o, req) => op.verTicket(db, o, req.params.id));
  r('POST', '/soporte/:id/responder', (o, req) => op.responderTicket(db, o, req.params.id, req.body));
  r('PATCH', '/soporte/:id', (o, req) => op.actualizarTicket(db, o, req.params.id, req.body));

  // Reembolsos: la cola la ve todo el equipo; decidir y registrar la devolución es solo de administración.
  r('GET', '/reembolsos', (o, req) => reembolsos.listarReembolsos(db, o, req.query));
  r('POST', '/reembolsos/:id/decidir', (o, req) => reembolsos.decidirReembolso(db, o, req.params.id, req.body));
  r('POST', '/reembolsos/:id/devuelto', (o, req) => reembolsos.registrarDevolucion(db, o, req.params.id, req.body));

  r('GET', '/auditoria', (o, req) => op.auditoria(db, o, req.query));

  // La auditoría no se modifica: no existe ruta de edición ni de borrado.
  app.route({ method: ['PUT', 'PATCH', 'DELETE'], url: '/api/operador/auditoria*', preHandler: guard, handler: async () => { throw new AppError('FORBIDDEN', 'La auditoría no se puede modificar.'); } });
}
