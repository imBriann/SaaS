## Qué cambia y por qué

<!-- Requisito, historia o defecto asociado (RF-xxx, HU-xx, BUG-xx, DT-xx). -->

## Lista de chequeo de auto-revisión

- [ ] El cambio es atómico y el mensaje de commit explica el porqué.
- [ ] Se contrastó con el requisito de origen (ERS PRO-SW-004) y no amplía el alcance.
- [ ] La batería de aislamiento entre tenants (`isolation.test.ts`) sigue en verde.
- [ ] Toda acción nueva de la IA pasa por el Gateway y tiene nivel de riesgo declarado.
- [ ] No se agregan secretos, claves ni datos personales reales al repositorio.
- [ ] Se agregaron o ajustaron pruebas para el comportamiento nuevo o corregido.
- [ ] El pipeline (build, lint, test) está en verde.
