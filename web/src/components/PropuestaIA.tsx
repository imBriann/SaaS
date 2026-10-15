import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Icon } from './icons';

/**
 * Propuesta de la IA a partir de la descripción del negocio. Cada dato muestra su estado real:
 *   confirmado → lo eligió o confirmó la persona;
 *   sugerido   → lo infirió la IA (con la frase del texto que lo respalda);
 *   pendiente  → no se pudo saber: se pregunta, sin inventar.
 * La IA nunca reemplaza en silencio lo que la persona respondió: los choques se muestran como conflicto.
 */
type Estado = 'confirmado' | 'sugerido' | 'pendiente';
type Cambiar = (cambios: Record<string, unknown>) => Promise<unknown>;

export const TAMANOS: [string, string][] = [['unipersonal', 'Solo yo'], ['2_5', '2 a 5 personas'], ['6_15', '6 a 15 personas'], ['mas_15', 'Más de 15']];
export const VOLUMENES: [string, string][] = [['bajo', 'Menos de 300 al mes'], ['medio', '300 a 1.500 al mes'], ['alto', 'Más de 1.500 al mes']];
const FUNCIONES: [string, string, string][] = [
  ['clientes', 'Clientes', 'Directorio e historial'], ['catalogo', 'Catálogo', 'Productos y servicios'], ['ventas', 'Ventas', 'Pedidos y cobros'],
  ['agenda', 'Agenda', 'Citas y turnos'], ['inventario', 'Inventario', 'Existencias y mínimos'], ['facturacion', 'Facturación', 'Documentos electrónicos'],
  ['conversaciones', 'WhatsApp', 'Bandeja de atención'], ['ia', 'Asistente IA', 'Responde y propone'], ['comisiones', 'Comisiones', 'Por persona o servicio'],
  ['membresias', 'Membresías', 'Planes y mensualidades'],
];
const BASE = ['clientes', 'catalogo'];

const PREGUNTA: Record<string, { pregunta: string; para: string }> = {
  actividad: { pregunta: '¿A qué se dedica tu negocio?', para: 'Con la actividad sugerimos funciones y textos pensados para tu sector.' },
  tamano: { pregunta: '¿Cuántas personas atenderán a tus clientes, contándote a ti?', para: 'Solo para estimar accesos. Al equipo lo invitas después, desde Equipo y comisiones.' },
  volumen_conv_mes: { pregunta: '¿Cuántas conversaciones de clientes recibes al mes?', para: 'Dimensiona WhatsApp y el asistente. Cuenta conversaciones, no mensajes sueltos. Es opcional.' },
  factura_electronica: { pregunta: '¿Necesitas emitir factura electrónica a tus clientes?', para: 'Si la necesitas, en el siguiente paso te pediremos NIT y dirección del negocio.' },
  modulos_sugeridos: { pregunta: '¿Qué funciones quieres activar?', para: 'Clientes y catálogo son la base. Puedes cambiar las demás cuando quieras.' },
};

const ETIQUETA_ESTADO: Record<Estado, string> = { confirmado: 'Confirmado por ti', sugerido: 'Sugerencia de la IA', pendiente: 'Pendiente' };

function EstadoDato({ estado }: { estado: Estado }) {
  return <span className={`ia-estado ${estado}`}><Icon n={estado === 'confirmado' ? 'ok' : estado === 'sugerido' ? 'ia' : 'reloj'} className="" size={13} />{ETIQUETA_ESTADO[estado]}</span>;
}

function Opciones({ valor, opciones, onElegir, ocupado, nombre }: { valor: string | null; opciones: [string, string][]; onElegir: (v: string | null) => void; ocupado: boolean; nombre: string }) {
  return (
    <div className="ia-opciones" role="radiogroup" aria-label={nombre}>
      {opciones.map(([v, n]) => <button key={v} type="button" role="radio" aria-checked={valor === v} className={`ia-opcion ${valor === v ? 'on' : ''}`} disabled={ocupado} onClick={() => onElegir(v)}>{n}</button>)}
      <button type="button" role="radio" aria-checked={valor === null} className={`ia-opcion sutil ${valor === null ? 'on' : ''}`} disabled={ocupado} onClick={() => onElegir(null)}>Aún no lo sé</button>
    </div>
  );
}

function FilaDato({ indice, titulo, estado, valor, evidencia, pregunta, para, ocupado, onConfirmar, children }: {
  indice: number; titulo: string; estado: Estado; valor: ReactNode; evidencia?: string; pregunta: string; para: string; ocupado: boolean; onConfirmar?: () => void; children: ReactNode;
}) {
  const [editando, setEditando] = useState(estado === 'pendiente');
  useEffect(() => { if (estado === 'pendiente') setEditando(true); }, [estado]);
  return (
    <article className={`ia-fila ${estado}`} style={{ ['--i' as any]: indice }}>
      <header className="ia-fila-cab"><h3>{titulo}</h3><EstadoDato estado={estado} /></header>
      {estado !== 'pendiente' && !editando && <p className="ia-valor" key={String(valor)}>{valor}</p>}
      {estado === 'sugerido' && evidencia && <p className="ia-evidencia"><span>Lo deduje de</span> «{evidencia}»</p>}
      {(estado === 'pendiente' || editando) && <><p className="ia-pregunta">{pregunta}</p><p className="ia-para">{para}</p></>}
      {editando && <div className="ia-editor">{children}</div>}
      <div className="ia-fila-acciones">
        {estado === 'sugerido' && !editando && onConfirmar && <button type="button" className="btn peq" disabled={ocupado} onClick={onConfirmar}><Icon n="ok" className="" size={14} />Es correcto</button>}
        {estado !== 'pendiente' && <button type="button" className="btn sutil peq" onClick={() => setEditando(!editando)}>{editando ? 'Listo' : 'Cambiar'}</button>}
      </div>
    </article>
  );
}

/** Actividad en dos pasos: el sector (buscable) habilita solo los tipos de ese sector. */
function SelectorActividad({ sectores, c, ocupado, cambiar }: { sectores: { id: string; nombre: string; tipos: string[] }[]; c: any; ocupado: boolean; cambiar: Cambiar }) {
  const [busqueda, setBusqueda] = useState('');
  const [aviso, setAviso] = useState('');
  const [otro, setOtro] = useState(c.otro_descripcion ?? '');
  const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const q = sinTildes(busqueda.trim());
  const visibles = useMemo(() => sectores.map((s) => ({ ...s, coinciden: q ? s.tipos.filter((t) => sinTildes(t).includes(q)) : [] }))
    .filter((s) => !q || sinTildes(s.nombre).includes(q) || s.coinciden.length), [sectores, q]);
  const actual = sectores.find((s) => s.id === c.sector);
  const elegirSector = async (id: string) => {
    if (id === c.sector) return;
    setAviso(c.tipo_negocio ? `Cambiaste de sector: «${c.tipo_negocio}» ya no aplica. Elige el tipo de negocio de tu nuevo sector.` : '');
    await cambiar({ sector: id });
  };
  return (
    <div className="actividad">
      <label className="actividad-buscar"><Icon n="buscar" className="" size={16} /><span className="sr">Buscar sector o tipo de negocio</span>
        <input type="search" className="input" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Busca tu actividad: veterinaria, ferretería, academia…" />
      </label>
      <div className="actividad-sectores" role="radiogroup" aria-label="Sector">
        {visibles.length === 0 && <p className="tenue peq-txt">Sin coincidencias. Elige «Otros» y descríbela en una frase.</p>}
        {visibles.map((s) => (
          <button key={s.id} type="button" role="radio" aria-checked={c.sector === s.id} disabled={ocupado} className={`actividad-sector ${c.sector === s.id ? 'on' : ''}`} onClick={() => elegirSector(s.id)}>
            <b>{s.nombre}</b>{s.coinciden.length > 0 && <small>{s.coinciden.slice(0, 2).join(' · ')}</small>}
          </button>
        ))}
      </div>
      {aviso && <p className="aviso peq-txt" role="status"><Icon n="info" className="" size={14} />{aviso}</p>}
      {actual && actual.id !== 'otro' && (
        <div className="actividad-tipos">
          <p className="ia-para">Tipo de negocio en <b>{actual.nombre}</b></p>
          <div className="ia-opciones" role="radiogroup" aria-label="Tipo de negocio">
            {actual.tipos.map((t) => <button key={t} type="button" role="radio" aria-checked={c.tipo_negocio === t} className={`ia-opcion ${c.tipo_negocio === t ? 'on' : ''}`} disabled={ocupado} onClick={() => { setAviso(''); cambiar({ tipo_negocio: t }); }}>{t}</button>)}
          </div>
        </div>
      )}
      {actual?.id === 'otro' && (
        <label className="campo"><span>Cuéntanos en una frase a qué te dedicas</span>
          <input className="input" maxLength={160} value={otro} onChange={(e) => setOtro(e.target.value)} onBlur={() => otro.trim() !== (c.otro_descripcion ?? '') && cambiar({ otro_descripcion: otro.trim() })} placeholder="Ej.: alquiler de trajes para eventos" />
        </label>
      )}
    </div>
  );
}

export function PropuestaIA({ c, ocupado, cambiar }: { c: any; ocupado: boolean; cambiar: Cambiar }) {
  const [sectores, setSectores] = useState<{ id: string; nombre: string; tipos: string[] }[]>([]);
  const [errorCatalogo, setErrorCatalogo] = useState('');
  useEffect(() => { api.get('/api/onboarding/catalogos').then((r) => setSectores(r.sectores)).catch(() => setErrorCatalogo('No pudimos cargar el catálogo de sectores. Recarga la página para intentarlo de nuevo.')); }, []);
  const estado = (k: string): Estado => (c[k] == null || (k === 'modulos_sugeridos' && !c[k]?.length) ? 'pendiente' : c.confirmados?.includes(k) ? 'confirmado' : 'sugerido');
  const estadoActividad: Estado = !c.sector || (c.sector !== 'otro' && !c.tipo_negocio) ? 'pendiente' : (c.confirmados?.includes('sector') || c.confirmados?.includes('tipo_negocio')) ? 'confirmado' : 'sugerido';
  const sector = sectores.find((s) => s.id === c.sector);
  const pregunta = (k: string) => c.preguntas?.[k] || PREGUNTA[k].pregunta;
  const nombreDe = (lista: [string, string][], v: unknown) => lista.find(([k]) => k === v)?.[1] ?? '';
  // Confirma de una vez lo que la IA sugirió y la persona revisó.
  const sugeridos = ['sector', 'tipo_negocio', 'tamano', 'volumen_conv_mes', 'factura_electronica', 'modulos_sugeridos'].filter((k) => c[k] != null && !c.confirmados?.includes(k));
  const confirmarTodo = () => cambiar(Object.fromEntries(sugeridos.map((k) => [k, c[k]])));
  const pendientes = [estadoActividad, estado('tamano'), estado('volumen_conv_mes'), estado('factura_electronica')].filter((e) => e === 'pendiente').length;

  return (
    <section className="ia-propuesta" aria-busy={ocupado} aria-labelledby="ia-propuesta-titulo">
      <header className="ia-propuesta-cab">
        <span className="ia-sello" aria-hidden="true"><Icon n="ia" className="" size={18} /></span>
        <div>
          <h2 id="ia-propuesta-titulo">Lo que entendí de tu negocio</h2>
          <p className="sec">{c.motor === 'reglas'
            ? 'Propuesta preparada con reglas porque el análisis con IA no respondió. Revísala con más cuidado.'
            : 'Propuesta de la IA a partir de tu descripción. Revisa cada dato: nada queda confirmado hasta que tú lo digas.'}</p>
        </div>
      </header>
      <ul className="ia-leyenda" aria-label="Estados de los datos">
        <li><EstadoDato estado="confirmado" /></li><li><EstadoDato estado="sugerido" /></li><li><EstadoDato estado="pendiente" /></li>
      </ul>
      {c.justificacion && <p className="ia-resumen">{c.justificacion}</p>}
      {errorCatalogo && <p className="aviso" role="alert">{errorCatalogo}</p>}

      {c.conflictos?.map((x: any) => (
        <div className="ia-conflicto" key={x.campo} role="status">
          <b>Tu respuesta y la nueva lectura no coinciden</b>
          <span>Conservamos lo que elegiste. ¿Quieres mantenerlo o usar la sugerencia?</span>
          <div className="fila envolver" style={{ gap: 8 }}>
            <button type="button" className="btn peq" disabled={ocupado} onClick={() => cambiar({ [x.campo]: x.valor })}>Mantener mi respuesta</button>
            <button type="button" className="btn sutil peq" disabled={ocupado} onClick={() => cambiar({ [x.campo]: x.sugerencia })}>Usar la sugerencia</button>
          </div>
        </div>
      ))}

      <div className="ia-filas">
        <FilaDato indice={0} titulo="Actividad" estado={estadoActividad} ocupado={ocupado}
          valor={c.sector === 'otro' ? `Otra actividad${c.otro_descripcion ? `: ${c.otro_descripcion}` : ''}` : <>{c.tipo_negocio} <span className="tenue">· {sector?.nombre ?? ''}</span></>}
          evidencia={c.evidencia?.tipo_negocio ?? c.evidencia?.sector} pregunta={c.preguntas?.sector || c.preguntas?.tipo_negocio || PREGUNTA.actividad.pregunta} para={PREGUNTA.actividad.para}
          onConfirmar={() => cambiar({ sector: c.sector, tipo_negocio: c.tipo_negocio })}>
          <SelectorActividad sectores={sectores} c={c} ocupado={ocupado} cambiar={cambiar} />
        </FilaDato>
        <FilaDato indice={1} titulo="Equipo que atenderá" estado={estado('tamano')} ocupado={ocupado} valor={nombreDe(TAMANOS, c.tamano)}
          evidencia={c.evidencia?.tamano} pregunta={pregunta('tamano')} para={PREGUNTA.tamano.para} onConfirmar={() => cambiar({ tamano: c.tamano })}>
          <Opciones nombre="Personas que atenderán" valor={c.tamano ?? null} opciones={TAMANOS} ocupado={ocupado} onElegir={(v) => cambiar({ tamano: v })} />
        </FilaDato>
        <FilaDato indice={2} titulo="Conversaciones al mes" estado={estado('volumen_conv_mes')} ocupado={ocupado} valor={nombreDe(VOLUMENES, c.volumen_conv_mes)}
          evidencia={c.evidencia?.volumen_conv_mes} pregunta={pregunta('volumen_conv_mes')} para={PREGUNTA.volumen_conv_mes.para} onConfirmar={() => cambiar({ volumen_conv_mes: c.volumen_conv_mes })}>
          <Opciones nombre="Conversaciones al mes" valor={c.volumen_conv_mes ?? null} opciones={VOLUMENES} ocupado={ocupado} onElegir={(v) => cambiar({ volumen_conv_mes: v })} />
        </FilaDato>
        <FilaDato indice={3} titulo="Factura electrónica" estado={estado('factura_electronica')} ocupado={ocupado} valor={c.factura_electronica ? 'Sí, la necesito' : 'No por ahora'}
          evidencia={c.evidencia?.factura_electronica} pregunta={pregunta('factura_electronica')} para={PREGUNTA.factura_electronica.para} onConfirmar={() => cambiar({ factura_electronica: c.factura_electronica })}>
          <Opciones nombre="Factura electrónica" valor={c.factura_electronica == null ? null : String(c.factura_electronica)} opciones={[['true', 'Sí, la necesito'], ['false', 'No por ahora']]} ocupado={ocupado}
            onElegir={(v) => cambiar({ factura_electronica: v === null ? null : v === 'true' })} />
        </FilaDato>
        <FilaDato indice={4} titulo="Funciones" estado={estado('modulos_sugeridos')} ocupado={ocupado}
          valor={FUNCIONES.filter(([k]) => c.modulos_sugeridos?.includes(k)).map(([, n]) => n).join(' · ')}
          pregunta={PREGUNTA.modulos_sugeridos.pregunta} para={PREGUNTA.modulos_sugeridos.para} onConfirmar={() => cambiar({ modulos_sugeridos: c.modulos_sugeridos })}>
          <div className="ia-funciones">
            {FUNCIONES.map(([k, n, desc]) => {
              const on = c.modulos_sugeridos?.includes(k);
              return <button key={k} type="button" aria-pressed={on} disabled={ocupado || BASE.includes(k)} className={`ia-funcion ${on ? 'on' : ''}`}
                onClick={() => cambiar({ modulos_sugeridos: on ? c.modulos_sugeridos.filter((x: string) => x !== k) : [...(c.modulos_sugeridos ?? []), k] })}>
                <b>{n}</b><small>{BASE.includes(k) ? 'Siempre incluida' : desc}</small></button>;
            })}
          </div>
        </FilaDato>
      </div>

      <footer className="ia-propuesta-pie">
        <span className="tenue peq-txt">{pendientes ? `${pendientes} ${pendientes === 1 ? 'dato pendiente' : 'datos pendientes'}. Solo la actividad es necesaria para continuar.` : 'Todo revisado. Puedes seguir ajustando después.'}</span>
        {sugeridos.length > 1 && <button type="button" className="btn peq" disabled={ocupado} onClick={confirmarTodo}><Icon n="ok" className="" size={14} />Confirmar las {sugeridos.length} sugerencias</button>}
      </footer>
    </section>
  );
}

/**
 * Lo que hace la IA mientras analiza. Los pasos describen la tarea y se resaltan por turnos mientras
 * la petición está en curso; los resultados solo aparecen cuando el servidor responde.
 */
const PASOS_ANALISIS = ['Leyendo tu descripción', 'Identificando sector y actividad', 'Estimando equipo y conversaciones', 'Revisando si necesitas facturar', 'Eligiendo funciones útiles'];

export function AnalisisEnCurso() {
  const [paso, setPaso] = useState(0);
  useEffect(() => {
    // Indicación cíclica de lo que hace la IA: no marca pasos como terminados (no hay progreso parcial real).
    const t = window.setInterval(() => setPaso((p) => (p + 1) % PASOS_ANALISIS.length), 1300);
    return () => clearInterval(t);
  }, []);
  return (
    <section className="ia-analisis" role="status" aria-live="polite">
      <span className="ia-sello pulso" aria-hidden="true"><Icon n="ia" className="" size={18} /></span>
      <div>
        <h2>Analizando tu negocio…</h2>
        <ol>{PASOS_ANALISIS.map((p, i) => <li key={p} className={i === paso ? 'curso' : ''} aria-current={i === paso ? 'step' : undefined}>{p}</li>)}</ol>
        <p className="tenue peq-txt">Suele tardar unos segundos. Nada se guarda como confirmado.</p>
      </div>
    </section>
  );
}
