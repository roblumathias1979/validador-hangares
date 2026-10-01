/**
 * admins.js — para ONDE vão os avisos e comandos de administração.
 *
 * Dois lugares guardam destino de administração, e confundir os dois espalha
 * aviso pela metade: `grupoAdministracao` de cada hangar (destino dos avisos de
 * erro) e a lista global `adminsWhatsapp` (números e grupos que comandam o bot,
 * como o grupo "Adm Bot 1Park SBJD"). Um aviso importante — ValidPark fora,
 * sistema com problema — deve chegar a TODOS eles, sem repetir o mesmo JID.
 */
function destinosAdmin(config) {
  const set = new Set();
  for (const h of (config.hangares || [])) {
    const g = String(h.grupoAdministracao || '').trim();
    if (g) set.add(g);
  }
  for (const a of (config.adminsWhatsapp || [])) {
    const s = String(a || '').trim();
    if (s) set.add(s);
  }
  return [...set];
}

module.exports = { destinosAdmin };
