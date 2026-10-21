import { Link } from 'react-router-dom';
import { PublicoLayout } from './Publico';
import { ConsultaSolicitud, DOCUMENTOS, DocumentoLegal, Fuente, FormularioSolicitud, Identificacion, fechaLarga, useLegal } from '../../components/LegalKit';
import { ConsultaReembolso, FormularioReembolso } from '../../components/ReembolsoForms';
import { Icon } from '../../components/icons';

/**
 * Zona legal de Omnegia. Cada afirmación jurídica cita la norma en la que se apoya, y esas normas se
 * leyeron en su texto oficial. Los datos de identificación del responsable salen de la configuración
 * del operador (nunca están escritos aquí). Al cambiar el fondo de un texto, sube LEGAL.version en el servidor.
 */

// Fuentes oficiales o compilaciones públicas de cada norma.
const F = {
  l1581: 'https://www.suin-juriscol.gov.co/viewDocument.asp?ruta=Leyes/1684507',
  d1377: 'https://www.suin-juriscol.gov.co/viewDocument.asp?id=1276081',
  l1480: 'https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=44306',
  l2439: 'https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=257116',
  l527: 'https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=4276',
  l2300: 'https://normativa.colpensiones.gov.co/compilacion/docs/ley_2300_2023.htm',
  sic: 'https://www.sic.gov.co',
  whatsapp: 'https://www.whatsapp.com/legal/business-terms',
};

const Correo = ({ info }: { info: ReturnType<typeof useLegal> }) => {
  const c = info?.responsable.correo;
  return c ? <a href={`mailto:${c}`}>{c}</a> : <>nuestro canal de soporte</>;
};

// =====================================================================================================
// Hub
// =====================================================================================================
export function Legal() {
  const info = useLegal();
  return <PublicoLayout transparente>
    <section className="legal-hero legal-hero-hub">
      <div>
        <h1>Zona legal</h1>
        <p className="legal-version">{info ? <>Versión {info.version} · vigente desde el {fechaLarga(info.vigente_desde)}</> : 'Cargando la versión vigente…'}</p>
        <p className="legal-lead">Aquí está todo lo que rige tu relación con Omnegia: las condiciones del servicio, cómo cuidamos tus datos, cómo ejercer tus derechos y a quién acudir. Está escrito para leerse, con la norma colombiana en la que se apoya cada punto.</p>
      </div>
    </section>
    <div className="legal-hub">
      <ul className="legal-tarjetas">
        {DOCUMENTOS.map((d) => <li key={d.ruta}><Link to={d.ruta}><h2>{d.titulo}</h2><p>{d.detalle}</p><span>Leer <Icon n="flecha" size={16} className="" /></span></Link></li>)}
      </ul>
      <section className="legal-texto legal-hub-id" aria-labelledby="id-t">
        <h2 id="id-t">Quién presta el servicio</h2>
        <p>Esta es la identificación de quien presta el servicio y es responsable del tratamiento de los datos personales de quienes usan Omnegia.</p>
        <Identificacion info={info} />
        <p className="legal-nota-sic"><Icon n="info" size={16} className="" />Autoridad de protección al consumidor y de protección de datos personales de Colombia: <a href={F.sic} target="_blank" rel="noopener noreferrer">Superintendencia de Industria y Comercio</a>.</p>
      </section>
    </div>
  </PublicoLayout>;
}

// =====================================================================================================
// Términos y condiciones
// =====================================================================================================
export function Terminos() {
  const info = useLegal();
  return <DocumentoLegal ruta="/terminos"
    resumen={<ul>
      <li>Omnegia es un servicio de software para negocios; el panel se activa cuando se confirma tu pago.</li>
      <li>Pagas por periodos. No hay renovación ni cobro automáticos: renuevas tú.</li>
      <li>Aceptas por escrito, con casillas, y guardamos la prueba de esa aceptación.</li>
      <li>La IA ayuda, pero puede equivocarse: tú supervisas, y siempre hay paso a una persona.</li>
      <li>Puedes pedir tus datos, retractarte o pedir un reembolso desde la web, y radicar una queja, todo con número de radicado.</li>
    </ul>}
    secciones={[
      { id: 'quienes', titulo: 'Quiénes somos', cuerpo: <>
        <p>Omnegia es un servicio en línea de software que presta la persona identificada abajo («Omnegia», «nosotros»). Estos datos se publican para que sepas con quién contratas (Ley 1480 de 2011, art. 50, literal a).</p>
        <Identificacion info={info} />
      </> },
      { id: 'servicio', titulo: 'Qué es Omnegia y qué incluye', cuerpo: <>
        <p>Omnegia es una plataforma para negocios que reúne en un mismo espacio: atención de clientes por WhatsApp con un asistente de inteligencia artificial y paso a una persona con radicados, directorio de clientes, agenda, ventas, inventario, cobros, facturación, suscripciones y reportes. Cada negocio trabaja en su propia empresa dentro de la plataforma, con sus propios permisos y datos.</p>
        <p>Las funciones disponibles son los módulos que eliges al configurar tu espacio. Algunas dependen de que conectes servicios de terceros (por ejemplo, WhatsApp o un proveedor de facturación electrónica); el panel muestra el estado de cada conexión. Una función que no esté conectada o configurada no se presta, y no te la cobramos como si lo estuviera.</p>
      </> },
      { id: 'aceptacion', titulo: 'Aceptación y contrato electrónico', cuerpo: <>
        <p>Antes de pagar debes marcar, una por una, las casillas que aceptan estos Términos, la <Link to="/privacidad">Política de tratamiento de datos personales</Link> y el inicio del servicio. El contrato se celebra por medios electrónicos: la oferta y su aceptación pueden expresarse mediante mensajes de datos y no pierden validez por ello (Ley 527 de 1999, arts. 5 y 14).</p>
        <p>Guardamos la prueba de tu aceptación: qué versión de los textos viste, la fecha y hora, y una huella técnica del origen de la conexión (no tu dirección IP en claro). Esto cumple el deber de dejar prueba de la aceptación de las condiciones generales y de que la aceptación sea expresa, inequívoca y verificable (Ley 1480 de 2011, arts. 49 y 50, literal d; Decreto 1377 de 2013, art. 8). Nunca interpretamos tu silencio como aceptación.</p>
        <p>Estos Términos están publicados en todo momento en esta página, para que puedas consultarlos, imprimirlos y descargarlos antes y después de contratar (Ley 1480 de 2011, art. 50, literal d).</p>
      </> },
      { id: 'quien', titulo: 'Quién puede usar Omnegia', cuerpo: <>
        <p>Omnegia está pensado para personas mayores de edad con capacidad legal para contratar, y para empresas representadas por quien tenga facultades para obligarlas. Si contratas en nombre de una empresa, declaras que tienes esas facultades.</p>
        <p>Si usas Omnegia para tu actividad económica, es posible que el Estatuto del Consumidor no te cubra: consumidor es quien adquiere como destinatario final, y para fines empresariales solo cuando esa necesidad no está ligada intrínsecamente a su actividad económica (Ley 1480 de 2011, art. 5, numeral 3). Aun así, <b>aplicamos a todos nuestros clientes las garantías de información, retracto, reversión del pago y atención de reclamos que se describen aquí</b>.</p>
      </> },
      { id: 'cuenta', titulo: 'Tu cuenta y su seguridad', cuerpo: <>
        <p>Para crear el espacio verificamos tu correo con un código de seis dígitos. Tú defines tu contraseña y los permisos de tu equipo (administración, recepción, supervisión, etc.). Eres responsable de custodiar tus credenciales y de lo que se haga con ellas; avísanos de inmediato si sospechas de un acceso no autorizado.</p>
        <p>Las sesiones caducan por inactividad y puedes cerrarlas en todos tus dispositivos. Cada empresa solo ve sus propios datos. Las acciones relevantes quedan en un registro de auditoría que no se puede modificar desde la aplicación.</p>
      </> },
      { id: 'precio', titulo: 'Contratación, precio y pago', cuerpo: <>
        <p>Armas tu configuración y, antes de pagar, ves un <b>resumen del pedido</b> con el detalle de cada módulo, el valor total y el tratamiento de impuestos que corresponda. Puedes corregirlo o cancelar la operación hasta antes de concluirla (Ley 1480 de 2011, art. 50, literal d). El precio que pagas es el del resumen que aceptas.</p>
        <p>El pago lo procesa Wompi, nuestra pasarela de pagos, ya sea en su propia página o en el formulario de pago de Omnegia. En ambos casos <b>los datos de tu tarjeta los recibe Wompi</b>: en nuestro formulario se cifran en tu navegador y viajan directo a Wompi, así que Omnegia no los ve ni los guarda. Para pagar con Nequi o PSE, el celular o el documento que escribes pasan por nuestro servidor solo para enviarlos a Wompi y no se guardan. Los medios de pago disponibles son los que Wompi confirma para nuestra cuenta, y se informan en la pantalla de pago.</p>
        <p>Con el formulario de Omnegia, además de nuestros textos aceptas los términos y la autorización de datos de Wompi, que se enlazan en esa pantalla.</p>
        <p>Cuando el pago se confirma te enviamos por correo la confirmación de la contratación, con la referencia, el valor pagado y la vigencia, y el comprobante de pago. La factura electrónica solo se emite cuando el proveedor tecnológico correspondiente esté configurado; mientras tanto, el comprobante de pago no tiene validez fiscal y se informa así en el propio documento.</p>
        <p>Las ofertas especiales o institucionales, con vigencia o precio distintos, se rigen además por las condiciones que se muestren en el resumen del pedido.</p>
      </> },
      { id: 'activacion', titulo: 'Activación del servicio', cuerpo: <>
        <p>Tu panel se crea cuando la pasarela confirma el pago, no antes: un borrador de configuración no es una empresa activa. Después del pago defines tu contraseña y tú inicias la creación de tu espacio; el servicio comienza cuando tu espacio queda creado.</p>
        <p>Informamos el plazo de activación antes de que concluyas la compra. Si el servicio no se activa en el plazo informado, o no se activa en absoluto, puedes resolver el contrato y recibir la devolución de todo lo pagado, sin retenciones, en un máximo de quince (15) días calendario (Ley 1480 de 2011, art. 50, literal h, según la Ley 2439 de 2024, art. 4).</p>
      </> },
      { id: 'vigencia', titulo: 'Vigencia, renovación y terminación', cuerpo: <>
        <p>Cada pago cubre un periodo de acceso. <b>No hay renovación automática ni cobro automático</b>: al terminar el periodo, tú decides si renuevas. Puedes terminar tu relación con Omnegia en cualquier momento, sin penalidad ni requisitos adicionales a los que hubo para contratar (Ley 1480 de 2011, art. 43, numerales 11 y 14).</p>
        <p>Si el periodo vence sin renovar, tu cuenta pasa por un periodo de gracia y luego a solo lectura: tu equipo puede consultar y exportar los datos, pero no registrar cambios, y el asistente deja de atender por WhatsApp. Tu información se conserva, y al renovar todo se reactiva. Desde el panel puedes exportar tus datos.</p>
        <p>Podemos suspender o terminar el servicio si incumples gravemente estos Términos (por ejemplo, usos ilícitos o que pongan en riesgo a otras empresas o a la plataforma), avisándote el motivo. Si terminamos el contrato sin que tú hayas incumplido, te devolvemos la parte del periodo pagado que no pudiste usar.</p>
        <p>No devolvemos el valor de periodos ya prestados cuando decides terminar por tu cuenta, salvo que la ley te dé ese derecho (retracto, falta de activación, cobro duplicado o reversión del pago). Cómo pedirlo se explica en la sección siguiente, y puedes hacerlo desde <Link to="/consumidor#reembolso">Reembolso y retracto</Link>.</p>
      </> },
      { id: 'retracto', titulo: 'Retracto, devoluciones y reversión del pago', cuerpo: <>
        <p>Antes de comprar te informamos la disponibilidad del servicio, el derecho de retracto y su término, y el tiempo de entrega (Ley 1480 de 2011, arts. 46 numeral 4 y 50 literal c). En contratos a distancia, el consumidor tiene derecho de retracto: puede ejercerlo dentro de los <b>cinco (5) días hábiles</b> siguientes a la celebración del contrato de servicios, y se le devuelve el dinero (art. 47).</p>
        <p>El retracto <b>no aplica a los contratos de prestación de servicios cuya prestación haya comenzado con el acuerdo del consumidor</b> (art. 47, numeral 1). Por eso, antes de pagar te pedimos que aceptes expresamente que el servicio comienza cuando se crea tu espacio: <b>hasta ese momento puedes retractarte; después, ya no</b>.</p>
        <p>Si te retractas, la devolución del dinero no puede exceder de quince (15) días calendario desde que ejerces el derecho y entregas los datos correctos y completos que necesitamos para hacerla, y se hace por el medio de pago que prefieras (Ley 1480 de 2011, art. 47, según la Ley 2439 de 2024, arts. 3 y 5). Para ejercerlo, usa el formulario de <Link to="/consumidor#reembolso">Reembolso y retracto</Link> con la referencia de tu pago y tu correo: si estás dentro del plazo y tu espacio aún no se creó, se aprueba al instante y recibes un radicado, y cuando hacemos la devolución te enviamos la referencia por correo.</p>
        <p>Mismo procedimiento si el servicio no se activó, si te cobraron dos veces o si no reconoces el cobro: la devolución es de todo lo pagado, sin descuentos ni retenciones, y no puede exceder los quince (15) días calendario.</p>
        <p>Si pagaste con tarjeta u otro medio electrónico y fuiste víctima de fraude, la operación no fue solicitada, el servicio no se prestó o no corresponde a lo contratado, puedes pedir la reversión del pago: presenta tu queja ante nosotros dentro de los cinco (5) días hábiles siguientes a que te enteraste, y notifica a quien emitió tu medio de pago (Ley 1480 de 2011, art. 51).</p>
      </> },
      { id: 'comercio', titulo: 'Lo que debes cumplir como comercio', cuerpo: <>
        <p>Al usar Omnegia con los datos de tus propios clientes, tú eres el <b>responsable del tratamiento</b> de esos datos y Omnegia actúa como tu <b>encargado</b> (Ley 1581 de 2012, art. 3, literales d y e; ver el Anexo de estos Términos). Por eso te comprometes a:</p>
        <ul>
          <li>Tener la <b>autorización previa, expresa e informada</b> de tus clientes para tratar sus datos, y poder probarla (Ley 1581 de 2012, art. 9; Decreto 1377 de 2013, arts. 5 a 8), e informarles tu propia política de tratamiento y cómo ejercer sus derechos.</li>
          <li>No cargar datos sensibles (por ejemplo, de salud o biométricos) sin la autorización explícita que exige la ley, informando que responder es facultativo, y sin condicionar un servicio a entregarlos (Ley 1581 de 2012, arts. 5 y 6; Decreto 1377 de 2013, art. 6). Si tu actividad maneja datos de salud, la responsabilidad de ese tratamiento es tuya.</li>
          <li>No tratar datos de niños, niñas y adolescentes salvo en los casos que la ley permite y con la autorización de su representante (Ley 1581 de 2012, art. 7; Decreto 1377 de 2013, art. 12).</li>
          <li>Si envías mensajes comerciales o publicitarios por WhatsApp, mensajería, SMS, correo o llamadas, hacerlo solo de lunes a viernes de 7:00 a. m. a 7:00 p. m. y sábados de 8:00 a. m. a 3:00 p. m., nunca domingos ni festivos, sin obligar a tus clientes a aceptarlos y con un mecanismo ágil para dejar de recibirlos (Ley 2300 de 2023, arts. 3 y 5).</li>
          <li>Cumplir las condiciones y políticas de WhatsApp para empresas (<a href={F.whatsapp} target="_blank" rel="noopener noreferrer">Términos de WhatsApp Business</a>), incluidas las que exigen contar con el consentimiento de las personas a quienes escribes.</li>
          <li>Ofrecer información veraz y suficiente sobre tus productos, precios y servicios, y atender los derechos de tus clientes como consumidores. Omnegia es solo la herramienta: no vende ni presta los bienes o servicios de tu negocio, y la relación de consumo es entre tú y tus clientes.</li>
          <li>No usar la plataforma para actividades ilícitas, engañosas o que vulneren derechos de terceros, ni para enviar mensajes masivos no solicitados.</li>
        </ul>
      </> },
      { id: 'ia', titulo: 'Inteligencia artificial', cuerpo: <>
        <p>El asistente de Omnegia usa modelos de inteligencia artificial de un proveedor externo (Claude, de Anthropic) para atender conversaciones, ayudarte a configurar tu espacio y proponer respuestas a tu equipo. Puede equivocarse o no entender una situación. Por eso:</p>
        <ul>
          <li>Tú eliges qué funciones del asistente están activas y puedes revisar lo que hace en el Centro de IA y en el registro de auditoría.</li>
          <li>El asistente solo ejecuta las acciones que tu configuración y sus permisos le permiten; las acciones que comprometen a un cliente piden la confirmación de la persona antes de ejecutarse.</li>
          <li>Los precios, planes y totales los calcula el sistema con reglas fijas, no la IA.</li>
          <li>Siempre hay una vía para pasar a una persona del equipo. Eres responsable de la supervisión de tu equipo y de las respuestas que tu negocio da a sus clientes.</li>
          <li>El asistente no presta asesoría jurídica, contable, tributaria ni médica. No tomes sus respuestas como tal.</li>
        </ul>
        <p>Debes presentar el asistente a tus clientes de forma que no los induzca a error sobre quién les responde (Ley 1480 de 2011, art. 50, literal b, sobre información veraz). Cómo se tratan los datos que pasan por la IA se explica en la <Link to="/privacidad#ia">Política de tratamiento de datos</Link>.</p>
      </> },
      { id: 'fiscal', titulo: 'Facturación electrónica y cobros de tus clientes', cuerpo: <>
        <p>Omnegia genera documentos de venta y prepara la facturación electrónica de tu negocio, pero <b>los documentos del entorno de pruebas no tienen validez fiscal</b>. La emisión con validez ante la DIAN exige conectar un proveedor tecnológico habilitado y completar tu información tributaria. Tus obligaciones tributarias son tuyas; Omnegia no es la DIAN ni tu asesor tributario.</p>
        <p>Si conectas una cuenta propia de Wompi para cobrar a tus clientes, la relación de pago es entre tú, tus clientes y Wompi. Omnegia solo registra el resultado y no ve datos de tarjeta.</p>
      </> },
      { id: 'terceros', titulo: 'Servicios de terceros', cuerpo: <>
        <p>Omnegia se apoya en servicios de terceros: WhatsApp (Meta) para mensajería, Wompi para pagos, Anthropic para el modelo de IA, Resend y Zoho Mail para correo, y proveedores de infraestructura (hosting y base de datos). Su disponibilidad y sus condiciones propias están fuera de nuestro control: si uno de ellos falla, cambia sus reglas o suspende tu cuenta, esa función puede dejar de operar sin que Omnegia incumpla, aunque te ayudaremos a resolverlo. Quién recibe qué datos se explica en la <Link to="/privacidad#proveedores">Política de tratamiento de datos</Link>.</p>
      </> },
      { id: 'disponibilidad', titulo: 'Disponibilidad y soporte', cuerpo: <>
        <p>Procuramos que el servicio esté disponible de forma continua, pero puede haber mantenimientos, fallas de terceros o interrupciones. No ofrecemos un acuerdo de nivel de servicio (SLA) con porcentajes de disponibilidad, salvo que se pacte por escrito.</p>
        <p>El soporte se presta desde el panel (Soporte, con número de radicado y seguimiento), por correo y por el WhatsApp de Omnegia, donde un asistente automático responde primero y pasa a una persona del equipo lo que no puede resolver, con un número de radicado. Las respuestas a las solicitudes del panel quedan en el panel y se notifican por correo; las de WhatsApp, en la misma conversación.</p>
      </> },
      { id: 'propiedad', titulo: 'Propiedad intelectual y tus contenidos', cuerpo: <>
        <p>El software, la marca y los materiales de Omnegia son de su titular. Te damos una licencia limitada, no exclusiva e intransferible para usar la plataforma mientras tu contrato esté vigente.</p>
        <p>Tus datos, catálogo, logotipo y contenidos siguen siendo tuyos. Nos autorizas a tratarlos únicamente para prestarte el servicio, en los términos del Anexo y de la Política de tratamiento de datos. Debes tener derecho a usar y cargar lo que subes.</p>
      </> },
      { id: 'responsabilidad', titulo: 'Responsabilidad', cuerpo: <>
        <p>Respondemos por el cumplimiento de nuestras obligaciones legales y contractuales y por las fallas de seguridad de las transacciones realizadas por los medios que disponemos (Ley 1480 de 2011, art. 50, literal f). No respondemos por daños causados por decisiones de tu negocio, por contenidos que tú o tu equipo cargan, por la mala configuración de tu espacio, por el uso indebido de credenciales que custodias, ni por la interrupción de servicios de terceros que no controlamos, en la medida en que la ley lo permita.</p>
        <p>Nada de lo dicho en estos Términos limita las obligaciones que la ley impone a los proveedores ni renuncia a derechos que la ley te reconoce: las cláusulas que lo hicieran serían ineficaces de pleno derecho (Ley 1480 de 2011, arts. 42 y 43).</p>
      </> },
      { id: 'datos', titulo: 'Datos personales', cuerpo: <>
        <p>El tratamiento de datos personales se rige por la <Link to="/privacidad">Política de tratamiento de datos personales</Link> y, para los datos de los clientes de tu negocio, por el Anexo de estos Términos. Puedes ejercer tus derechos y pedir la eliminación de tus datos en <Link to="/eliminacion-de-datos">Eliminación de datos de usuario</Link>.</p>
      </> },
      { id: 'pqr', titulo: 'Peticiones, quejas y reclamos', cuerpo: <>
        <p>Puedes radicar una petición, queja o reclamo en cualquier momento en <Link to="/consumidor">Derechos del consumidor y PQR</Link>, o desde Soporte si ya tienes cuenta. Recibes un número de radicado con fecha y hora, y puedes hacerle seguimiento (Ley 1480 de 2011, art. 50, literal g, según la Ley 2439 de 2024, art. 4). Para el contacto directo: <Correo info={info} />.</p>
      </> },
      { id: 'cambios', titulo: 'Cambios a estos Términos', cuerpo: <>
        <p>Cada versión tiene un número y una fecha de vigencia visibles arriba. Si cambiamos algo de fondo, te avisaremos por correo o en el panel antes de que aplique, y lo que pagaste se rige por las condiciones con las que contrataste hasta que termine tu periodo. Si no estás de acuerdo con el cambio, puedes terminar tu relación sin penalidad. El cambio de una finalidad del tratamiento de datos requiere una nueva autorización tuya (Decreto 1377 de 2013, art. 5).</p>
      </> },
      { id: 'ley', titulo: 'Ley aplicable y autoridades', cuerpo: <>
        <p>Estos Términos se rigen por las leyes de la República de Colombia. Las controversias pueden llevarse ante la <a href={F.sic} target="_blank" rel="noopener noreferrer">Superintendencia de Industria y Comercio</a>, que tiene competencia en todo el territorio nacional para asuntos de consumo, o ante los jueces competentes (Ley 1480 de 2011, art. 58). Para reclamaciones sobre datos personales, ante la misma Superintendencia, una vez agotado el trámite ante nosotros (Ley 1581 de 2012, art. 16). No te obligamos a acudir a la justicia arbitral (Ley 1480 de 2011, art. 43, numeral 12).</p>
      </> },
      { id: 'encargo', titulo: 'Anexo: tratamiento de datos por cuenta de tu comercio', cuerpo: <>
        <p>Este Anexo es el contrato de transmisión de datos personales entre tu comercio (<b>responsable</b>) y Omnegia (<b>encargado</b>), en los términos del artículo 25 del Decreto 1377 de 2013. Aplica a los datos de tus clientes que cargas o que llegan a tu empresa por los canales que conectas (clientes, conversaciones, citas, ventas, documentos).</p>
        <ul>
          <li><b>Alcance.</b> Omnegia almacena, organiza, muestra a tu equipo, transmite por los canales que conectas y, con el asistente de IA, procesa esos datos únicamente para prestarte el servicio contratado.</li>
          <li><b>Instrucciones.</b> Tratamos los datos según la política y las finalidades que tú hayas informado a tus clientes y según tus instrucciones desde el panel, y de acuerdo con las leyes aplicables.</li>
          <li><b>Principios.</b> Damos tratamiento a los datos conforme a los principios de la Ley 1581 de 2012 (art. 4).</li>
          <li><b>Seguridad.</b> Salvaguardamos la seguridad de las bases de datos con medidas técnicas, humanas y administrativas: aislamiento de datos por empresa, control de acceso por permisos, cifrado de secretos y de documentos sensibles en reposo, registro de auditoría y segundo factor para el personal de la plataforma.</li>
          <li><b>Confidencialidad.</b> Guardamos reserva sobre los datos, incluso después de terminada la relación. El personal de la plataforma no accede a los datos privados de tu empresa. La única excepción es la que tú instruyas: si compartes una conversación concreta con el soporte de Omnegia desde el panel, el equipo de soporte puede leerla (sin responder ni modificar nada) durante el plazo que elijas, de 24 horas a 7 días, o hasta que retires el acceso; cada lectura queda registrada en tu auditoría.</li>
          <li><b>Derechos de los titulares.</b> Si un cliente tuyo nos escribe para ejercer sus derechos, te damos traslado en un máximo de dos (2) días hábiles e informamos al interesado (Ley 1581 de 2012, art. 15, numeral 1). Tú respondes la solicitud; te damos las herramientas para consultar, corregir o suprimir los datos desde el panel.</li>
          <li><b>Incidentes.</b> Si se presenta una violación de los códigos de seguridad con riesgo para la información de los titulares, la informamos a la Superintendencia de Industria y Comercio y te avisamos (Ley 1581 de 2012, art. 18, literal k).</li>
          <li><b>Fin del contrato.</b> Al terminar la relación puedes exportar tus datos. Después los suprimimos o los conservamos solo mientras una norma o una obligación contractual lo exija (Decreto 1377 de 2013, art. 11).</li>
          <li><b>Subencargados y transmisión internacional.</b> Para prestar el servicio usamos los proveedores listados en la Política de tratamiento de datos. Una transmisión internacional hecha para que el encargado trate datos por cuenta del responsable no requiere informarse al titular ni su consentimiento cuando existe este contrato (Decreto 1377 de 2013, art. 24, numeral 2).</li>
        </ul>
      </> },
    ]}
    fuentes={<>
      <Fuente href={F.l1480}>Ley 1480 de 2011 — Estatuto del Consumidor</Fuente>
      <Fuente href={F.l2439}>Ley 2439 de 2024 — Medidas de protección al consumidor de comercio electrónico</Fuente>
      <Fuente href={F.l527}>Ley 527 de 1999 — Comercio electrónico y mensajes de datos</Fuente>
      <Fuente href={F.l1581}>Ley 1581 de 2012 — Protección de datos personales</Fuente>
      <Fuente href={F.d1377}>Decreto 1377 de 2013 — Reglamenta parcialmente la Ley 1581 de 2012</Fuente>
      <Fuente href={F.l2300}>Ley 2300 de 2023 — Protección del derecho a la intimidad de los consumidores</Fuente>
    </>}
  />;
}

// =====================================================================================================
// Política de tratamiento de datos personales
// =====================================================================================================
export function Privacidad() {
  const info = useLegal();
  return <DocumentoLegal ruta="/privacidad"
    resumen={<ul>
      <li>Usamos tus datos para crear y operar tu cuenta, cobrarte, darte soporte y mantener el servicio seguro.</li>
      <li>No vendemos tus datos ni los usamos para publicidad de terceros.</li>
      <li>Tienes derecho a conocer, actualizar, rectificar y pedir la supresión de tus datos, y a revocar tu autorización.</li>
      <li>Respondemos las consultas en 10 días hábiles y los reclamos en 15 días hábiles.</li>
      <li>Si tu comercio es cliente de Omnegia, tú decides sobre los datos de tus clientes; nosotros los tratamos por tu cuenta.</li>
    </ul>}
    secciones={[
      { id: 'aviso', titulo: 'Aviso de privacidad', cuerpo: <>
        <p>Al registrarte, escribirnos o usar Omnegia nos das datos personales. El <b>responsable</b> de su tratamiento es la persona identificada abajo. Los usamos para las <a href="#finalidades">finalidades</a> que se explican abajo, y tú tienes los <a href="#derechos">derechos</a> que allí se describen. La política completa de tratamiento es este mismo documento, y siempre puedes volver a consultarlo aquí (Decreto 1377 de 2013, arts. 14 y 15). En esta plataforma no pedimos datos sensibles; si en algún formulario te los pidiéramos, responder sería facultativo.</p>
      </> },
      { id: 'responsable', titulo: 'Responsable y roles', cuerpo: <>
        <Identificacion info={info} />
        <p>Omnegia es <b>responsable</b> de los datos de las personas que se registran, administran una empresa en la plataforma, nos contactan o contratan, y de los de visitantes del sitio. Es <b>encargado</b> de los datos de los clientes finales de cada comercio: el comercio decide para qué se usan y Omnegia los trata por su cuenta (Ley 1581 de 2012, art. 3, literales d y e; art. 18). Cuando concurren ambas calidades en una misma persona, cumple los deberes de cada una (art. 18, parágrafo).</p>
        <p>Área responsable de atender consultas y reclamos de datos personales (Decreto 1377 de 2013, arts. 13 y 23): equipo de protección de datos de Omnegia, por correo a <Correo info={info} /> o con el formulario de <Link to="/eliminacion-de-datos">Eliminación de datos de usuario</Link>.</p>
      </> },
      { id: 'principios', titulo: 'Principios que seguimos', cuerpo: <>
        <p>Tratamos los datos conforme a los principios de la Ley 1581 de 2012 (art. 4): <b>legalidad</b> (solo como la ley lo permite), <b>finalidad</b> (un propósito legítimo, informado), <b>libertad</b> (con tu consentimiento previo, expreso e informado), <b>veracidad o calidad</b>, <b>transparencia</b> (puedes saber qué datos tenemos de ti), <b>acceso y circulación restringida</b>, <b>seguridad</b> y <b>confidencialidad</b>. Solo recolectamos los datos pertinentes y adecuados para cada finalidad (Decreto 1377 de 2013, art. 4) y no usamos medios engañosos o fraudulentos para recolectarlos.</p>
      </> },
      { id: 'datos', titulo: 'Qué datos tratamos', cuerpo: <>
        <ul>
          <li><b>De tu cuenta:</b> nombre, correo electrónico (verificado con un código), contraseña (guardada solo como huella irreversible) y rol dentro de tu empresa.</li>
          <li><b>De tu negocio:</b> nombre comercial, dirección web elegida, descripción de tu actividad, logotipo y colores, teléfono de contacto, ubicación (país, departamento, municipio y dirección), NIT cuando lo indicas, y el catálogo que cargas.</li>
          <li><b>De facturación y pago:</b> datos del contratante, con el documento de identificación guardado cifrado; referencia, valor y estado de cada pago. Los datos de tu tarjeta los recibe Wompi: nosotros no los vemos ni los guardamos (en nuestro formulario de pago se cifran en tu navegador y viajan directo a Wompi). El celular de Nequi o el documento de PSE pasan por nuestro servidor solo para enviarlos a Wompi y no se guardan.</li>
          <li><b>De uso y seguridad:</b> sesiones, intentos de ingreso, huellas técnicas del origen de la conexión (no la dirección IP en claro), agente del navegador, registro de acciones relevantes y métricas técnicas del servicio.</li>
          <li><b>De comunicación:</b> las solicitudes que nos envías (soporte, datos personales, PQR), los correos que te enviamos con su estado de entrega y, si escribes al WhatsApp de Omnegia, tu número, tu nombre de perfil y los mensajes de la conversación.</li>
          <li><b>De los clientes de tu comercio</b> (como encargado): los que tu negocio carga o recibe por los canales que conectas, como nombre, teléfono, historial de conversaciones, citas, compras y documentos. Qué datos recolectas y por qué lo decide tu comercio.</li>
        </ul>
        <p>No pedimos ni necesitamos datos sensibles (salud, biométricos, origen racial, orientación política, etc.) para prestar el servicio (Ley 1581 de 2012, art. 5). Si tu negocio los trata, debe cumplir los requisitos reforzados que la ley exige (art. 6).</p>
      </> },
      { id: 'finalidades', titulo: 'Para qué los usamos', cuerpo: <>
        <ul>
          <li>Crear, activar, operar y mantener tu cuenta y tu empresa dentro de la plataforma, y cumplir el contrato contigo.</li>
          <li>Verificar tu identidad y tu correo, y proteger la cuenta y la plataforma de accesos no autorizados y fraudes.</li>
          <li>Procesar y conciliar pagos, emitir comprobantes y, cuando corresponda, facturas.</li>
          <li>Enviarte comunicaciones del servicio: códigos, confirmaciones, avisos de vencimiento, respuestas de soporte y cambios en estos textos.</li>
          <li>Atender tus consultas, solicitudes de soporte (por el panel, por correo o por el WhatsApp de Omnegia), peticiones, quejas, reclamos y solicitudes sobre tus datos. En WhatsApp responde primero un asistente automático con reglas fijas; no le revela a quien escribe qué empresas tiene registradas un número ni datos de ninguna cuenta.</li>
          <li>Configurar tu espacio y operar el asistente de IA por cuenta de tu comercio (ver <a href="#ia">Tratamiento con inteligencia artificial</a>).</li>
          <li>Medir el funcionamiento técnico, detectar fallas y mejorar el servicio con datos agregados.</li>
          <li>Cumplir obligaciones legales, contables y fiscales, y defender nuestros derechos ante autoridades.</li>
        </ul>
        <p><b>No vendemos tus datos, no los cedemos para publicidad de terceros y no te enviamos publicidad sin tu autorización.</b> Si en el futuro usáramos los datos para una finalidad distinta, te lo diremos y pediremos una nueva autorización (Decreto 1377 de 2013, art. 5).</p>
      </> },
      { id: 'ia', titulo: 'Tratamiento con inteligencia artificial', cuerpo: <>
        <p>En el registro, el texto con que describes tu negocio se envía a un modelo de IA (Claude, de Anthropic) para proponerte una configuración; tú la revisas y puedes corregirla antes de pagar. Cuando tu comercio activa el asistente, los mensajes de conversación y los datos de tu empresa que el asistente necesita para responder se envían al modelo en cada interacción, únicamente por cuenta de tu comercio.</p>
        <p>Las decisiones con efectos económicos —planes, precios, totales— las calculan reglas fijas del sistema, no la IA, y el asistente actúa solo dentro de los permisos configurados. No escribas en el campo de descripción ni en tus mensajes con el asistente contraseñas ni datos que no quieras compartir.</p>
      </> },
      { id: 'autorizacion', titulo: 'Tu autorización', cuerpo: <>
        <p>Pedimos tu autorización <b>previa, expresa e informada</b> antes de tratar tus datos, a más tardar al recolectarlos (Ley 1581 de 2012, arts. 4 y 9; Decreto 1377 de 2013, art. 5). La obtenemos con una casilla que tú marcas durante el registro; nunca consideramos el silencio como autorización (Decreto 1377 de 2013, art. 7). Conservamos la prueba de la autorización: versión de este texto, fecha y hora, y huella del origen (Decreto 1377 de 2013, art. 8).</p>
        <p>Al aceptar esta Política, <b>autorizas de manera expresa e inequívoca</b> el tratamiento descrito aquí, incluida la transmisión y la transferencia de tus datos a los <a href="#proveedores">proveedores</a> listados más abajo, aunque estén fuera de Colombia (Ley 1581 de 2012, art. 26, literales a y e). Puedes revocar la autorización cuando quieras, salvo que tengas un deber legal o contractual de permanecer en la base de datos (Decreto 1377 de 2013, art. 9).</p>
      </> },
      { id: 'proveedores', titulo: 'Quién más recibe tus datos', cuerpo: <>
        <p>Para prestar el servicio, algunos proveedores tratan datos por nuestra cuenta (transmisión) o por la tuya. Este es el listado, con su propósito. Varios de ellos están o pueden tratar datos fuera de Colombia.</p>
        <div className="legal-tabla" role="region" aria-label="Proveedores" tabIndex={0}>
          <table>
            <thead><tr><th scope="col">Proveedor</th><th scope="col">Para qué</th><th scope="col">Qué datos</th></tr></thead>
            <tbody>
              <tr><th scope="row">Render</th><td>Alojar la aplicación</td><td>Todo lo que procesa la aplicación</td></tr>
              <tr><th scope="row">Supabase</th><td>Base de datos</td><td>Datos de cuentas, empresas y registros</td></tr>
              <tr><th scope="row">Resend</th><td>Enviar correos automáticos</td><td>Correo, nombre y contenido del mensaje</td></tr>
              <tr><th scope="row">Zoho Mail</th><td>Recibir el correo de soporte</td><td>Lo que nos escribes</td></tr>
              <tr><th scope="row">Wompi</th><td>Procesar pagos</td><td>Datos de pago que ingresas en su sitio o en el formulario de pago de Omnegia</td></tr>
              <tr><th scope="row">Meta (WhatsApp)</th><td>Mensajería con los clientes de cada comercio y atención por el WhatsApp de Omnegia</td><td>Número, nombre de perfil y mensajes</td></tr>
              <tr><th scope="row">Anthropic</th><td>Modelo de IA (Claude)</td><td>Descripción del negocio y mensajes que atiende el asistente</td></tr>
            </tbody>
          </table>
        </div>
        <p>Cuando un proveedor trata datos por cuenta del responsable, se trata de una transmisión: no necesita tu consentimiento adicional si existe un contrato de transmisión con las obligaciones de dar tratamiento conforme a los principios, salvaguardar la seguridad y guardar confidencialidad (Decreto 1377 de 2013, arts. 24 y 25). Fuera de esos casos, solo entregamos datos a autoridades que los soliciten en ejercicio de sus funciones o por orden judicial (Ley 1581 de 2012, art. 10, literal a) y a terceros que tú autorices.</p>
      </> },
      { id: 'derechos', titulo: 'Tus derechos', cuerpo: <>
        <p>Como titular de los datos tienes derecho a (Ley 1581 de 2012, art. 8):</p>
        <ul>
          <li>Conocer, actualizar y rectificar tus datos, incluidos los parciales, inexactos, incompletos, fraccionados, que induzcan a error o cuyo tratamiento no esté autorizado o esté prohibido.</li>
          <li>Solicitar prueba de la autorización que nos diste.</li>
          <li>Ser informado, previa solicitud, del uso que le hemos dado a tus datos.</li>
          <li>Presentar quejas ante la Superintendencia de Industria y Comercio por infracciones a la ley.</li>
          <li>Revocar la autorización y solicitar la supresión de tus datos cuando no se respeten los principios, derechos y garantías.</li>
          <li>Acceder de forma gratuita a los datos que hayan sido objeto de tratamiento. Puedes consultar gratis al menos una vez cada mes calendario y cada vez que haya cambios sustanciales en esta política (Decreto 1377 de 2013, art. 21).</li>
        </ul>
        <p>Los pueden ejercer tú, tus causahabientes, tu representante o apoderado (acreditando la calidad) o quien actúe por estipulación a favor tuyo; los de niños, niñas y adolescentes, quienes los representan (Decreto 1377 de 2013, art. 20).</p>
      </> },
      { id: 'procedimiento', titulo: 'Cómo ejercer tus derechos', cuerpo: <>
        <p>Usa el formulario de <Link to="/eliminacion-de-datos">Eliminación de datos de usuario</Link> o escríbenos a <Correo info={info} />. Es gratuito, queda constancia con un radicado y puedes consultar su estado. Antes de actuar verificamos tu identidad.</p>
        <ul>
          <li><b>Consultas</b> (ver tus datos): respondemos en máximo diez (10) días hábiles desde su recibo. Si no es posible, te avisamos el motivo y la nueva fecha, que no superará cinco (5) días hábiles más (Ley 1581 de 2012, art. 14).</li>
          <li><b>Reclamos</b> (corregir, actualizar, suprimir o por presunto incumplimiento): indica quién eres, los hechos, una dirección de contacto y los documentos que quieras hacer valer. Si está incompleto, te lo pedimos en los cinco (5) días siguientes; si pasan dos (2) meses sin que lo completes, entendemos que desististe. Registramos la leyenda «reclamo en trámite» en máximo dos (2) días hábiles. Respondemos en máximo quince (15) días hábiles desde el día siguiente a su recibo; si no es posible, te avisamos el motivo y la nueva fecha, que no superará ocho (8) días hábiles más (art. 15).</li>
          <li>Si no somos los competentes (por ejemplo, porque los datos son de clientes de un comercio), damos traslado a quien corresponda en máximo dos (2) días hábiles y te informamos (art. 15, numeral 1).</li>
          <li>La supresión y la revocatoria no proceden si tienes un deber legal o contractual de permanecer en la base de datos (Decreto 1377 de 2013, art. 9). Cuando no procede, te lo explicamos.</li>
          <li>Si agotas este trámite y no estás conforme, puedes acudir a la <a href={F.sic} target="_blank" rel="noopener noreferrer">Superintendencia de Industria y Comercio</a> (Ley 1581 de 2012, art. 16).</li>
        </ul>
      </> },
      { id: 'seguridad', titulo: 'Seguridad', cuerpo: <>
        <p>Manejamos la información con medidas técnicas, humanas y administrativas para evitar su adulteración, pérdida, consulta, uso o acceso no autorizado o fraudulento (Ley 1581 de 2012, art. 4, literal g). Entre ellas: contraseñas guardadas solo como huella irreversible; cifrado de secretos de terceros y de documentos de identificación en reposo; conexión cifrada; aislamiento de los datos de cada empresa en la base de datos; permisos por rol; registro de auditoría que la aplicación no puede modificar; y segundo factor por correo para el personal de la plataforma, que además no tiene acceso a los datos privados de las empresas, salvo una conversación que una empresa comparta con soporte por tiempo limitado, con registro de cada lectura.</p>
        <p>Si se presenta una violación de los códigos de seguridad con riesgo para la información de los titulares, la informamos a la Superintendencia de Industria y Comercio (Ley 1581 de 2012, arts. 17 literal n y 18 literal k).</p>
      </> },
      { id: 'conservacion', titulo: 'Cuánto tiempo los conservamos', cuerpo: <>
        <p>Solo conservamos los datos durante el tiempo razonable y necesario para las finalidades que justificaron el tratamiento, atendiendo a las normas administrativas, contables, fiscales, jurídicas e históricas aplicables. Cumplidas las finalidades, los suprimimos, salvo que una obligación legal o contractual exija conservarlos (Decreto 1377 de 2013, art. 11). La prueba de la relación comercial —identidad del cliente, su voluntad de contratar, el pago y la entrega del servicio— se conserva por el mismo tiempo que los documentos de comercio (Ley 1480 de 2011, art. 50, literal e).</p>
        <p>Algunos datos técnicos se eliminan automáticamente muy pronto: los códigos de verificación, a más tardar un día después de crearse; los intentos de ingreso, a los dos días; los enlaces de recuperación de contraseña vencidos, a los siete días. Los correos con códigos o enlaces de acceso se guardan cifrados y su contenido se borra cuando el proveedor los acepta.</p>
        <p>Las conversaciones con el WhatsApp de Omnegia se eliminan automáticamente <b>90 días después del último mensaje</b>. Si en la conversación se abrió una solicitud de soporte, esa solicitud (con su radicado, un resumen y el número de contacto) se conserva como las demás solicitudes que nos presentas.</p>
        <p><b>Vigencia de esta política y de las bases de datos.</b> Esta política rige desde la fecha indicada arriba. Las bases de datos de cuentas y empresas se mantienen mientras dure la relación contigo y el tiempo adicional que exijan las normas.</p>
      </> },
      { id: 'menores', titulo: 'Niños, niñas y adolescentes', cuerpo: <>
        <p>Omnegia no está dirigido a menores de edad y no recolectamos datos de ellos a propósito. El tratamiento de datos de niños, niñas y adolescentes está proscrito salvo los de naturaleza pública, y solo es posible cuando responde al interés superior del menor, respeta sus derechos fundamentales y cuenta con la autorización de su representante legal (Ley 1581 de 2012, art. 7; Decreto 1377 de 2013, art. 12). Si un comercio carga datos de menores (por ejemplo, una academia o un club deportivo), él es el responsable de cumplir esos requisitos. Si crees que un menor nos entregó datos, escríbenos y los suprimiremos.</p>
      </> },
      { id: 'cookies', titulo: 'Cookies y almacenamiento', cuerpo: <>
        <p>Usamos únicamente lo necesario para que el sitio funcione. El detalle está en la <Link to="/cookies">Política de cookies y almacenamiento</Link>.</p>
      </> },
      { id: 'cambios', titulo: 'Cambios en esta política', cuerpo: <>
        <p>Si hacemos cambios sustanciales —sobre quién es el responsable o sobre las finalidades— te los comunicaremos antes de aplicarlos o, a más tardar, cuando los apliquemos, y pediremos una nueva autorización si cambia la finalidad (Decreto 1377 de 2013, arts. 5 y 13). Cada versión tiene su número y su fecha. Cuando la ley exija inscribir nuestras bases de datos en el Registro Nacional de Bases de Datos que administra la Superintendencia de Industria y Comercio, lo haremos (Ley 1581 de 2012, art. 25).</p>
      </> },
    ]}
    fuentes={<>
      <Fuente href={F.l1581}>Ley 1581 de 2012 — Protección de datos personales (hábeas data)</Fuente>
      <Fuente href={F.d1377}>Decreto 1377 de 2013 — Reglamenta parcialmente la Ley 1581 de 2012</Fuente>
      <Fuente href={F.l1480}>Ley 1480 de 2011 — Estatuto del Consumidor</Fuente>
      <Fuente href={F.sic}>Superintendencia de Industria y Comercio — autoridad de protección de datos personales</Fuente>
    </>}
  />;
}

// =====================================================================================================
// Eliminación de datos de usuario
// =====================================================================================================
export function EliminacionDatos() {
  const info = useLegal();
  return <DocumentoLegal ruta="/eliminacion-de-datos"
    resumen={<ul>
      <li>Puedes pedir que eliminemos, consultemos o corrijamos tus datos, o que dejemos de tratarlos.</li>
      <li>Es gratis. Recibes un radicado y puedes consultar el estado cuando quieras.</li>
      <li>Antes de actuar verificamos que eres tú. No eliminamos nada de otra persona.</li>
      <li>Respondemos en máximo 15 días hábiles (10 si solo consultas).</li>
      <li>Hay datos que la ley nos obliga a conservar; te explicamos cuáles y por qué.</li>
    </ul>}
    secciones={[
      { id: 'solicitar', titulo: 'Pide la eliminación de tus datos', cuerpo: <>
        <p>Esta es la página de instrucciones de eliminación de datos de usuario de Omnegia. Completa el formulario y recibirás un número de radicado y un correo de confirmación. Si prefieres, escríbenos a <Correo info={info} /> indicando tu nombre, el correo o teléfono con el que te registraste o con el que nos escribiste, y lo que necesitas.</p>
        <FormularioSolicitud modo="datos" />
      </> },
      { id: 'estado', titulo: 'Consulta el estado de tu solicitud', cuerpo: <>
        <p>Con el radicado y el correo que usaste puedes ver en qué estado va tu solicitud y la fecha objetivo de respuesta.</p>
        <ConsultaSolicitud />
      </> },
      { id: 'proceso', titulo: 'Qué pasa después', cuerpo: <>
        <ol className="legal-pasos">
          <li><b>Registramos</b> tu solicitud y te enviamos el radicado por correo.</li>
          <li><b>Verificamos tu identidad</b> respondiendo al correo que indicaste, para asegurarnos de que quien pide es el titular (o su representante, con la acreditación correspondiente) (Decreto 1377 de 2013, art. 20).</li>
          <li><b>Actuamos.</b> Si procede, suprimimos o corregimos tus datos y te confirmamos por escrito. Si no procede —total o parcialmente—, te explicamos el motivo.</li>
          <li><b>Cumplimos los plazos.</b> Consultas: 10 días hábiles, prorrogables por máximo 5 más con aviso. Reclamos, correcciones y supresiones: 15 días hábiles, prorrogables por máximo 8 más con aviso (Ley 1581 de 2012, arts. 14 y 15).</li>
        </ol>
        <p>Si no estás de acuerdo con la respuesta, puedes acudir a la <a href={F.sic} target="_blank" rel="noopener noreferrer">Superintendencia de Industria y Comercio</a> (Ley 1581 de 2012, art. 16).</p>
      </> },
      { id: 'casos', titulo: 'Según tu situación', cuerpo: <>
        <dl className="legal-definiciones">
          <div><dt>Administro o trabajo en una empresa de Omnegia</dt><dd>Podemos suprimir tus datos de cuenta (nombre, correo, acceso). Si eres el único administrador, eliminar tu acceso implica cerrar la empresa o transferir su administración antes: te lo indicaremos. Antes de cerrar puedes exportar los datos de tu empresa desde el panel.</dd></div>
          <div><dt>Soy cliente de un comercio que usa Omnegia</dt><dd>El comercio es el responsable de tus datos y Omnegia los trata por su cuenta. Por eso damos traslado de tu solicitud al comercio en máximo 2 días hábiles y te informamos (Ley 1581 de 2012, art. 15, numeral 1). Puedes también dirigirte directamente al comercio.</dd></div>
          <div><dt>Le escribí al WhatsApp de Omnegia</dt><dd>Guardamos la conversación (tu número, tu nombre de perfil y los mensajes) para atenderte y darle seguimiento, y la eliminamos automáticamente 90 días después del último mensaje. Si pediste ayuda de una persona, la solicitud de soporte que se abrió se conserva como las demás solicitudes. Puedes pedir que la eliminemos antes con el formulario, indicando el número desde el que escribiste.</dd></div>
          <div><dt>Empecé un registro y no lo terminé</dt><dd>Podemos eliminar el borrador de tu registro (descripción del negocio, datos que escribiste y código de verificación) a tu solicitud.</dd></div>
        </dl>
      </> },
      { id: 'conservamos', titulo: 'Qué datos debemos conservar', cuerpo: <>
        <p>La supresión no procede cuando tienes un deber legal o contractual de permanecer en la base de datos (Decreto 1377 de 2013, art. 9), y los datos solo se suprimen cuando se cumple la finalidad y ninguna norma exige conservarlos (art. 11). En la práctica, aunque suprimamos tu cuenta, podemos conservar por el tiempo que exijan las normas:</p>
        <ul>
          <li>Los registros de pagos, comprobantes y documentos de venta o facturación, y la prueba de la relación comercial —identidad del contratante, voluntad de contratar, pago y entrega del servicio—, por el mismo tiempo que los documentos de comercio (Ley 1480 de 2011, art. 50, literal e).</li>
          <li>La prueba de tu aceptación de estos textos y de las solicitudes que presentaste (Decreto 1377 de 2013, art. 8).</li>
          <li>El registro de auditoría de seguridad, que la aplicación no puede modificar, y la información necesaria para defendernos ante una autoridad.</li>
        </ul>
        <p>Lo que conservemos queda bloqueado para cualquier otro uso y se suprime cuando termine ese deber.</p>
      </> },
      { id: 'meta', titulo: 'Para usuarios de WhatsApp y Meta', cuerpo: <>
        <p>Si interactuaste con Omnegia por WhatsApp o por una aplicación de Meta, estas son las instrucciones para solicitar la eliminación de tus datos: usa el formulario de arriba, indicando el número de teléfono desde el que escribiste. Esta página es la URL de instrucciones de eliminación de datos de usuario de Omnegia.</p>
      </> },
    ]}
    fuentes={<>
      <Fuente href={F.l1581}>Ley 1581 de 2012 — arts. 8, 14, 15 y 16</Fuente>
      <Fuente href={F.d1377}>Decreto 1377 de 2013 — arts. 8, 9, 11 y 20</Fuente>
      <Fuente href={F.l1480}>Ley 1480 de 2011 — art. 50, literal e</Fuente>
    </>}
  />;
}

// =====================================================================================================
// Cookies y almacenamiento
// =====================================================================================================
export function Cookies() {
  return <DocumentoLegal ruta="/cookies"
    resumen={<ul>
      <li>Usamos una sola cookie, la de tu sesión, para mantenerte dentro de tu panel.</li>
      <li>No usamos cookies de publicidad ni de analítica de terceros.</li>
      <li>Guardamos en tu navegador solo lo que necesita el registro y el panel para funcionar.</li>
    </ul>}
    secciones={[
      { id: 'que', titulo: 'Qué usamos y para qué', cuerpo: <>
        <div className="legal-tabla" role="region" aria-label="Cookies y almacenamiento" tabIndex={0}>
          <table>
            <thead><tr><th scope="col">Nombre</th><th scope="col">Tipo</th><th scope="col">Para qué</th><th scope="col">Duración</th></tr></thead>
            <tbody>
              <tr><th scope="row"><code>sid</code></th><td>Cookie necesaria</td><td>Mantiene tu sesión iniciada. Es <i>httpOnly</i> (la página no puede leerla), <i>SameSite=Lax</i> y, en producción, solo viaja por conexión cifrada.</td><td>Hasta 7 días, y se cierra antes si pasan 12 horas sin actividad (valores por defecto).</td></tr>
              <tr><th scope="row"><code>borrador</code>, <code>empresa</code></th><td>Almacenamiento local</td><td>Recuerdan tu registro en curso y la empresa que elegiste, para que no pierdas lo que escribiste.</td><td>Hasta que los borres o termine el alta.</td></tr>
              <tr><th scope="row"><code>alta-datos…</code>, <code>descripcion_inicial</code>, <code>funciones_elegidas</code>, <code>plan_elegido</code></th><td>Almacenamiento de sesión</td><td>Conservan lo que llenaste si vuelves atrás durante el registro.</td><td>Hasta que cierres la pestaña.</td></tr>
            </tbody>
          </table>
        </div>
        <p>Son elementos estrictamente necesarios para prestar el servicio que pides. No usamos cookies de publicidad, de seguimiento entre sitios ni de analítica de terceros. Si algún día lo hiciéramos, te lo diríamos antes y pediríamos tu autorización.</p>
      </> },
      { id: 'control', titulo: 'Cómo controlarlas', cuerpo: <>
        <p>Puedes borrar la cookie y el almacenamiento desde la configuración de tu navegador, o cerrar tu sesión desde el panel. Si bloqueas la cookie de sesión no podrás iniciar sesión, porque es la que prueba que eres tú.</p>
        <p>El tratamiento de cualquier dato personal que se relacione con ellas se rige por la <Link to="/privacidad">Política de tratamiento de datos personales</Link>.</p>
      </> },
    ]}
    fuentes={<Fuente href={F.l1581}>Ley 1581 de 2012 — Protección de datos personales</Fuente>}
  />;
}

// =====================================================================================================
// Derechos del consumidor y PQR
// =====================================================================================================
export function Consumidor() {
  const info = useLegal();
  return <DocumentoLegal ruta="/consumidor"
    resumen={<ul>
      <li>Antes de pagar ves el resumen de tu pedido, y puedes cancelarlo hasta concluirlo.</li>
      <li>Tienes 5 días hábiles para retractarte, hasta que el servicio comience al crear tu espacio.</li>
      <li>Pide aquí tu reembolso: si cumples las condiciones de la ley, se aprueba al instante y se devuelve en máximo 15 días calendario.</li>
      <li>Si pagaste y algo salió mal, también puedes pedir la reversión del pago.</li>
      <li>Radica aquí tu petición, queja o reclamo y recibe un radicado con fecha y hora.</li>
    </ul>}
    secciones={[
      { id: 'derechos', titulo: 'Tus derechos al contratar en línea', cuerpo: <>
        <ul>
          <li><b>Saber con quién contratas:</b> nombre o razón social, NIT, dirección de notificación judicial, teléfono y correo, siempre visibles (Ley 1480 de 2011, art. 50, literal a). Están en la <Link to="/legal">Zona legal</Link>.</li>
          <li><b>Información clara y completa</b> del servicio: sus características, el precio total con impuestos, los medios de pago, el plazo de activación y el derecho de retracto con su procedimiento (art. 50, literales b y c).</li>
          <li><b>Condiciones generales</b> disponibles para consultar, imprimir y descargar antes y después de comprar, aunque no hayas decidido comprar (art. 50, literal d).</li>
          <li><b>Resumen del pedido</b> antes de pagar, con el detalle de lo que compras y el total, disponible para imprimir o descargar; aceptación expresa, inequívoca y verificable; derecho a cancelar hasta antes de concluir la operación; y un <b>acuse de recibo</b> a más tardar el día calendario siguiente (art. 50, literal d).</li>
          <li><b>Que no se presuma tu voluntad</b>: tu silencio nunca se toma como consentimiento si de ahí se derivan cobros u obligaciones (art. 50, literal d).</li>
          <li><b>Seguridad</b> en los medios que ponemos a tu disposición y en la información de tu transacción (art. 50, literal f).</li>
          <li><b>Plazo de entrega:</b> debe cumplirse el plazo que aceptaste antes de concluir la compra, o, a falta de plazo, 30 días calendario; si no se cumple, puedes terminar el contrato y recibir todo lo pagado en un máximo de 15 días calendario (art. 50, literal h, según la Ley 2439 de 2024, art. 4).</li>
        </ul>
      </> },
      { id: 'retracto', titulo: 'Derecho de retracto', cuerpo: <>
        <p>En las ventas a distancia puedes retractarte dentro de los <b>5 días hábiles</b> siguientes a la celebración del contrato de servicios, y te devolvemos el dinero. No aplica a servicios cuya prestación haya comenzado con tu acuerdo (Ley 1480 de 2011, art. 47, numeral 1). En Omnegia, <b>el servicio comienza cuando se crea tu espacio</b>, y antes de pagar te pedimos aceptarlo de forma expresa.</p>
        <p>La devolución se hace por el medio de pago que prefieras y no puede exceder 15 días calendario desde que ejerces el derecho y nos das los datos correctos y completos (Ley 2439 de 2024, arts. 3 y 5). Para ejercerlo, usa el formulario de la sección siguiente con la referencia de tu pago: es el mismo medio de la transacción original, en línea (Ley 1480 de 2011, art. 46, numeral 2).</p>
      </> },
      { id: 'reembolso', titulo: 'Pide tu reembolso o retracto', cuerpo: <>
        <p>Sirve para retractarte, para pedir la devolución si el servicio no se activó, o si te cobraron dos veces o no reconoces el cobro. Necesitas la <b>referencia de tu pago</b> (empieza por <span className="mono">SUB-</span> y está en el correo de confirmación) y el <b>correo con el que contrataste</b>.</p>
        <ul>
          <li><b>Se aprueba al instante</b> el retracto dentro de los 5 días hábiles si tu espacio aún no se creó, la falta de activación comprobada y el cobro duplicado verificable.</li>
          <li><b>Lo revisa una persona</b> en los demás casos. Nunca rechazamos una solicitud automáticamente: si no procede, te explicamos el motivo por escrito.</li>
          <li>La devolución es de <b>todo lo pagado, sin descuentos ni retenciones</b>, por el medio de pago que prefieras, y no excede los <b>15 días calendario</b> desde tu solicitud (Ley 1480 de 2011, art. 47, según la Ley 2439 de 2024, arts. 3 y 5). Te enviamos por correo la referencia de la devolución.</li>
          <li>Si se aprueba por retracto o por falta de activación, el espacio no se crea con ese pago.</li>
        </ul>
        <FormularioReembolso />
        <h3 className="legal-sub">Consulta el estado de tu reembolso</h3>
        <ConsultaReembolso />
      </> },
      { id: 'reversion', titulo: 'Reversión del pago', cuerpo: <>
        <p>Si pagaste por internet con una tarjeta u otro instrumento de pago electrónico y fuiste víctima de fraude, la operación no fue solicitada, no recibiste lo comprado o no corresponde a lo solicitado o está defectuoso, puedes pedir la reversión. Presenta la queja a Omnegia dentro de los 5 días hábiles siguientes a que te enteraste, devuelve el servicio o producto cuando sea procedente, y notifica la reclamación a quien emitió tu medio de pago, que junto con los demás participantes del pago reversará la transacción (Ley 1480 de 2011, art. 51).</p>
      </> },
      { id: 'pqr', titulo: 'Radica una petición, queja o reclamo', cuerpo: <>
        <p>Cuéntanos qué pasó. Recibirás un número de radicado con fecha y hora, un correo de confirmación y la posibilidad de consultar el seguimiento (Ley 1480 de 2011, art. 50, literal g, según la Ley 2439 de 2024, art. 4). Si ya tienes cuenta, también puedes hacerlo desde Soporte en tu panel. Contacto directo: <Correo info={info} />.</p>
        <FormularioSolicitud modo="pqr" />
        <h3 className="legal-sub">Consulta el estado</h3>
        <ConsultaSolicitud />
      </> },
      { id: 'autoridad', titulo: 'Autoridad de protección al consumidor', cuerpo: <>
        <p>La autoridad de protección al consumidor de Colombia es la <a href={F.sic} target="_blank" rel="noopener noreferrer">Superintendencia de Industria y Comercio</a> (Ley 1480 de 2011, art. 50, parágrafo). Para presentar una demanda de protección al consumidor debes acompañar la reclamación directa que le hiciste al proveedor (art. 58, numeral 5): por eso conviene radicarla primero aquí. No necesitas abogado para estos procesos (art. 58, numeral 4).</p>
      </> },
    ]}
    fuentes={<>
      <Fuente href={F.l1480}>Ley 1480 de 2011 — Estatuto del Consumidor (arts. 46, 47, 50, 51 y 58)</Fuente>
      <Fuente href={F.l2439}>Ley 2439 de 2024 — Medidas de protección al consumidor de comercio electrónico</Fuente>
      <Fuente href={F.sic}>Superintendencia de Industria y Comercio</Fuente>
    </>}
  />;
}
