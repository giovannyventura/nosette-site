/**
 * nosette-tracking.js — Camada de tracking + envio de leads (Nosette Arquitetura)
 *
 * Injetar via <script defer src="/nosette-tracking.js"></script> em TODAS as páginas
 * HTML estáticas do export Next.js, logo antes de </body> (depois dos chunks _next/static).
 *
 * Site é um export estático Next.js com hidratação client-side — os componentes React
 * (form de orçamento, chips) continuam funcionando normalmente; este script SÓ escuta
 * eventos no DOM já hidratado (não substitui nem interfere na lógica React existente).
 *
 * Referência completa: cerebro/clientes/lan4/tracking/NOSETTE-blueprint-tracking-2026-08-25.md
 * Padrão replicado de: cerebro/clientes/lan4/tracking/upload/main.js (lan4EnviaRd, normalização PII)
 *
 * IMPORTANTE PRO VITOR: o formulário "quote-v2__form" (componente React) tem
 * onSubmit={e => e.preventDefault()} — ou seja, o React não faz nada no submit hoje.
 * Este script adiciona um SEGUNDO listener de 'submit' no mesmo <form> (via
 * addEventListener, não sobrescreve o handler do React) que faz o envio real pro RD
 * Station. Se/quando você portar essa lógica de envio pra dentro do componente React
 * (onSubmit nativo), REMOVA a seção "5. FORM DE ORÇAMENTO" deste arquivo pra não
 * duplicar o envio do lead — o resto (GTM, WhatsApp modal, cta_click) pode continuar.
 */

/* ─────────────────────────────────────────────────────────────────────
   1. dataLayer + helpers (mesmo padrão de normalização do main.js da LAN4)
   ───────────────────────────────────────────────────────────────────── */
window.dataLayer = window.dataLayer || [];

var NOSETTE_RD_TOKEN = 'd5d170dfe71825a3ebc37e6699f10652'; // token público de conversão RD — mesma conta LAN4 (ver blueprint seção 6)

/* ─── Código de monitoramento RD Station (Path B, 2026-09-03) ───────────
   Rastreador nativo do RD — grava o cookie __trf.src e atribui a origem
   do lead (orgânico/direto/referral/paga), que a API de conversão sozinha
   não cobre sem UTM na URL. Mesma conta da LAN4 → MESMO ID de loader.

   >>> AÇÃO NECESSÁRIA: substituir NOSETTE_RD_LOADER_ID pelo ID da conta.
   RD Station Marketing → Configurações → Código de monitoramento →
   "Copiar código". src:
   https://d335luupugsy2.cloudfront.net/js/loader-scripts/<UUID>-loader.js
   Cole só o <UUID> abaixo (é o MESMO usado no main.js da LAN4). */
var NOSETTE_RD_LOADER_ID = 'c6fb78de-10d6-4e17-8ad6-85f5e6ba1008';
if (NOSETTE_RD_LOADER_ID && NOSETTE_RD_LOADER_ID.indexOf('COLE-O-ID') === -1) {
  (function () {
    var s = document.createElement('script');
    s.type = 'text/javascript';
    s.async = true;
    s.src = 'https://d335luupugsy2.cloudfront.net/js/loader-scripts/' + NOSETTE_RD_LOADER_ID + '-loader.js';
    (document.head || document.body).appendChild(s);
  })();
}
var NOSETTE_RD_FUNIL_IDENTIFICADOR_FORM = 'nosette-form-orcamento';
var NOSETTE_RD_FUNIL_IDENTIFICADOR_WHATSAPP = 'nosette-whatsapp-click';
var NOSETTE_WHATSAPP_NUMERO = '5511921288889';
var NOSETTE_WHATSAPP_MSG_PADRAO = 'Olá! Gostaria de solicitar um orçamento.';

function nosetteEventId() {
  return (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'evt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

function nosetteNormalizeEmail(raw) {
  return (raw || '').trim().toLowerCase();
}

/* Telefone cru → só dígitos com DDI 55. Mesma validação da LAN4: exige DDD real
   (11-99) e celular de 9 dígitos começando com 9 — evita PII incorreta nas
   plataformas quando o usuário digita telefone incompleto. */
function nosettePhoneDigits(raw) {
  var d = (raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 13 && d.slice(0, 2) === '55') return d;
  if (d.length === 11) {
    var ddd = parseInt(d.slice(0, 2), 10);
    if (ddd >= 11 && ddd <= 99 && d.charAt(2) === '9') return '55' + d;
  }
  return '';
}
function nosetteNormalizePhoneGoogle(raw) {
  var d = nosettePhoneDigits(raw);
  return d ? '+' + d : ''; // Enhanced Conversions (Google Ads): E.164 com '+'
}
function nosetteNormalizePhoneMeta(raw) {
  return nosettePhoneDigits(raw); // Advanced Matching/CAPI (Meta): só dígitos, sem '+'
}

function nosetteSplitName(nome) {
  var parts = (nome || '').trim().split(/\s+/);
  return {
    first: (parts[0] || '').toLowerCase(),
    last: (parts.length > 1 ? parts[parts.length - 1] : '').toLowerCase()
  };
}

/* Envio ao RD Station — API de conversão v2 (mesmo padrão lan4EnviaRd).
   Business logic (pipeline/estágio/dono do deal) fica no workflow do RD
   Marketing configurado na interface, não aqui — ver blueprint seção 6.

   MIGRAÇÃO 2026-09-03 (v1.3 → v2): a API 1.3 não populava os campos
   nativos "Origem"/"Fonte" do card — só os cf_utm_* (texto livre). A v2
   (api.rd.services/platform/conversions, envelope event_type/event_family
   =CDP) resolve "Origem"/"Fonte" a partir de traffic_source/traffic_medium/
   traffic_campaign/traffic_value. Os call sites continuam passando o
   payload no formato antigo; a conversão pro envelope v2 acontece aqui. */
/* API Key da conversão v2 (query ?api_key=). Na maioria das contas RD é o
   MESMO valor do token público antigo da v1.3 (por isso reusamos
   NOSETTE_RD_TOKEN). Se o 1º lead de teste voltar 401/invalid: gerar a
   chave em RD Station Marketing → Integrações → API Key e colar aqui.
   Mesma conta da LAN4 → mesma chave do main.js. */
var NOSETTE_RD_API_KEY = NOSETTE_RD_TOKEN;

function nosetteRdV2Envelope(payload) {
  var p = Object.assign({}, payload);
  var identificador = p.identificador || p.conversion_identifier;
  delete p.identificador;
  delete p.token_rdstation;
  delete p.conversion_identifier;
  p.conversion_identifier = identificador;
  if (p.nome != null && p.name == null) { p.name = p.nome; }
  delete p.nome;
  Object.keys(p).forEach(function (k) {
    if (p[k] === '' || p[k] == null) delete p[k];
  });
  return { event_type: 'CONVERSION', event_family: 'CDP', payload: p };
}

function nosetteEnviaRd(payload) {
  return fetch('https://api.rd.services/platform/conversions?api_key=' + encodeURIComponent(NOSETTE_RD_API_KEY), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(nosetteRdV2Envelope(payload))
  });
}

/* UTMs → sessionStorage (persiste na navegação). Anexado ao payload do RD e à
   mensagem do WhatsApp SOMENTE se existir utm_source real na URL de entrada —
   nunca inventar origem de mídia paga (regra da LAN4, replicada aqui). */
var NOSETTE_UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

(function () {
  try {
    var qs = new URLSearchParams(window.location.search);
    var found = {};
    NOSETTE_UTM_KEYS.forEach(function (k) { var v = qs.get(k); if (v) found[k] = v; });
    if (Object.keys(found).length) sessionStorage.setItem('nosette_utms', JSON.stringify(found));
  } catch (e) { /* sessionStorage indisponível: segue sem UTMs */ }
})();

function nosetteGetUtms() {
  try { return JSON.parse(sessionStorage.getItem('nosette_utms') || '{}'); }
  catch (e) { return {}; }
}

/* Referrer da PRIMEIRA página da sessão → sessionStorage. Capturado na
   entrada (não no submit — aí document.referrer já seria a própria página
   do site). Usado só como ÚLTIMO fallback de origem, quando não há UTM
   nem cookie __trf.src (caso típico: clique rápido no botão de WhatsApp
   antes do rastreador do RD gravar o cookie). */
(function () {
  try {
    if (sessionStorage.getItem('nosette_ref') === null) {
      sessionStorage.setItem('nosette_ref', document.referrer || '');
    }
  } catch (e) { /* sessionStorage indisponível: segue sem referrer */ }
})();

/* Deriva {source, medium} a partir de um referrer. Vocabulário alinhado
   ao que o RD entende (medium decide a categoria "Origem"):
   - google/bing/yahoo/duckduckgo        → organic  → "Busca Orgânica"
   - instagram/facebook/linkedin/youtube
     /tiktok/t.co(twitter)/pinterest     → social   → "Social"
   - qualquer outro domínio externo      → referral → "Referência"
   - sem referrer / mesmo domínio        → '' (não anexa nada) */
function nosetteRefOrigem(ref) {
  if (!ref) return null;
  var host;
  try { host = new URL(ref).hostname.replace(/^www\./, '').toLowerCase(); }
  catch (e) { return null; }
  if (!host || host === location.hostname.replace(/^www\./, '').toLowerCase()) return null;
  var SEARCH = /(^|\.)(google|bing|yahoo|duckduckgo|ecosia|yandex)\./;
  var SOCIAL = /(^|\.)(instagram|facebook|fb|l\.facebook|lm\.facebook|linkedin|lnkd|youtube|youtu\.be|tiktok|t\.co|twitter|x|pinterest|reddit|threads)\.?/;
  if (SEARCH.test(host)) return { source: host.split('.').slice(-2, -1)[0] || host, medium: 'organic' };
  if (SOCIAL.test(host)) {
    var name = host.split('.').slice(-2, -1)[0] || host;
    if (name === 'fb' || host.indexOf('facebook') > -1) name = 'facebook';
    if (host === 't.co' || name === 'x') name = 'twitter';
    if (host === 'youtu' || host.indexOf('youtube') > -1) name = 'youtube';
    return { source: name, medium: 'social' };
  }
  return { source: host, medium: 'referral' };
}

/* Cookie __trf.src — gravado pelo código de monitoramento nativo do RD
   (Path B). Fonte de verdade de atribuição do RD (cobre orgânico/direto/
   referral, não só UTM). Se presente, vai em traffic_source. */
function nosetteTrfSrc() {
  try {
    var m = document.cookie.match(/(?:^|;\s*)__trf\.src=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  } catch (e) { return ''; }
}

/* Campos de atribuição (traffic_*) para a API de conversão v2 — é ISSO
   que popula os campos nativos "Origem"/"Fonte" no card do lead. Os
   cf_utm_* continuam indo em paralelo (histórico/fallback, texto livre).
   Regra da LAN4 mantida: só anexa origem se houver dado real (UTM na URL
   OU cookie __trf.src). */
function nosetteUtmPayload() {
  var u = nosetteGetUtms();
  var trf = nosetteTrfSrc();
  var p = {};
  /* Prioridade de atribuição:
     1. cookie __trf.src (rastreador nativo do RD — mais completo)
     2. UTMs da URL de entrada
     3. referrer da 1ª página (só source+medium derivados) */
  if (trf) {
    p.traffic_source = trf;
  } else if (u.utm_source) {
    p.traffic_source   = u.utm_source;
    if (u.utm_medium)   p.traffic_medium   = u.utm_medium;
    if (u.utm_campaign) p.traffic_campaign = u.utm_campaign;
    if (u.utm_term)     p.traffic_value    = u.utm_term;
  } else {
    var ref = nosetteRefOrigem(sessionStorage.getItem('nosette_ref'));
    if (ref) { p.traffic_source = ref.source; p.traffic_medium = ref.medium; }
  }
  if (u.utm_source)   p.cf_utm_source   = u.utm_source;
  if (u.utm_medium)   p.cf_utm_medium   = u.utm_medium;
  if (u.utm_campaign) p.cf_utm_campaign = u.utm_campaign;
  if (u.utm_term)     p.cf_utm_term     = u.utm_term;
  if (u.utm_content)  p.cf_utm_content  = u.utm_content;
  return p;
}

/* Chamar SÓ no callback de sucesso do envio ao RD Station — mesmo padrão
   lan4PushLead.

   eventName separa os dois fluxos (padrão LAN4 — cada um tem tag/conversão
   própria no GTM, NÃO compartilham):
   - 'lead_form_submit'      → form de orçamento. Dispara: GA4 generate_lead,
                               GAds "Conversao Lead - Site Novo", Meta Pixel Lead.
   - 'whatsapp_lead_submit'  → modal do WhatsApp. Dispara: GA4 whatsapp_lead,
                               GAds "Botão de WhatsApp", Meta Pixel Contact
                               (com advanced matching). NÃO conta como Lead no
                               Meta nem como generate_lead no GA4. */
function nosettePushLead(identificador, p, eventName) {
  var name = nosetteSplitName(p.nome);
  window.dataLayer.push({
    event: eventName || 'lead_form_submit',
    form_identifier: identificador,
    event_id: p._eventId || nosetteEventId(),
    lead: {
      tipo_projeto: p.tipo_projeto || '',
      servico_de_interesse: p.servico_de_interesse || '',
      urgencia: p.urgencia || '',
      metragem: p.metragem || ''
    },
    user_data: {
      email: nosetteNormalizeEmail(p.email),
      phone: nosetteNormalizePhoneGoogle(p.telefone),
      phone_meta: nosetteNormalizePhoneMeta(p.telefone),
      first_name: name.first,
      last_name: name.last
    }
  });
}

/* ─────────────────────────────────────────────────────────────────────
   2. form_start — primeira interação com o form de orçamento (1x por form)
   ───────────────────────────────────────────────────────────────────── */
document.addEventListener('click', function (e) {
  var chip = e.target.closest ? e.target.closest('.quote-v2__form .quote-v2__chip') : null;
  var input = e.target.closest ? e.target.closest('.quote-v2__form .quote-v2__input') : null;
  var el = chip || input;
  if (!el) return;
  var form = el.closest('form');
  if (!form || form.dataset.nosetteStarted) return;
  form.dataset.nosetteStarted = '1';
  window.dataLayer.push({ event: 'form_start', form_identifier: NOSETTE_RD_FUNIL_IDENTIFICADOR_FORM });
}, true);

/* input (etapa 2) foca antes de clicar — cobre esse caminho também, e é o
   sinal de que a etapa 2 montou: dispara form_step nº 2 (1x por form).
   O funil GA4 fica form_start → form_step(1) → form_step(2) → generate_lead. */
document.addEventListener('focusin', function (e) {
  var input = e.target.closest ? e.target.closest('.quote-v2__form .quote-v2__input') : null;
  if (!input) return;
  var form = input.closest('form');
  if (!form) return;
  if (!form.dataset.nosetteStarted) {
    form.dataset.nosetteStarted = '1';
    window.dataLayer.push({ event: 'form_start', form_identifier: NOSETTE_RD_FUNIL_IDENTIFICADOR_FORM });
  }
  if (!form.dataset.nosetteStep2) {
    form.dataset.nosetteStep2 = '1';
    window.dataLayer.push({
      event: 'form_step',
      form_identifier: NOSETTE_RD_FUNIL_IDENTIFICADOR_FORM,
      form_step_number: 2,
      form_step_total: 2
    });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   3. form_step + captura persistente dos chips da etapa 1
   ───────────────────────────────────────────────────────────────────── */

/* O form de orçamento é um wizard React: ao ir pra etapa 2, os campos de
   chip da etapa 1 (Tipo de projeto / Tipo de serviço / Urgência) são
   DESMONTADOS do DOM. Se lermos `.quote-v2__chip.is-active` só no submit
   (etapa 2), sempre volta vazio. Por isso guardamos a seleção da etapa 1
   em NOSETTE_STEP1 a cada clique de chip, enquanto ela ainda está montada. */
var NOSETTE_STEP1 = { tipo_projeto: '', servico_de_interesse: '', urgencia: '' };

function nosetteLeChipsEtapa1() {
  var form = document.querySelector('.quote-v2__form');
  if (!form) return;
  var LABEL_TO_KEY = {
    'Tipo de projeto': 'tipo_projeto',
    'Tipo de serviço': 'servico_de_interesse',
    'Urgência': 'urgencia'
  };
  var fields = form.querySelectorAll('.quote-v2__field');
  for (var i = 0; i < fields.length; i++) {
    var label = fields[i].querySelector('.quote-v2__label');
    if (!label) continue;
    var key = LABEL_TO_KEY[label.textContent.trim()];
    if (!key) continue;
    // só sobrescreve se ESTE campo tem chips no DOM agora (etapa 1 montada);
    // se a etapa 1 já desmontou, mantém o valor guardado no clique anterior
    var todosChips = fields[i].querySelectorAll('.quote-v2__chip');
    if (!todosChips.length) continue;
    var ativos = fields[i].querySelectorAll('.quote-v2__chip.is-active');
    var vals = Array.prototype.map.call(ativos, function (c) { return c.textContent.trim(); });
    // multi-seleção só faz sentido em "Tipo de serviço"; nos outros pegamos o 1º
    NOSETTE_STEP1[key] = key === 'servico_de_interesse' ? vals.join(', ') : (vals[0] || '');
  }
}

/* Delegado no document: pega clique em qualquer chip da etapa 1. Roda no
   próximo tick pra ler o DOM já com a classe .is-active atualizada pelo React. */
document.addEventListener('click', function (e) {
  var chip = e.target.closest ? e.target.closest('.quote-v2__form .quote-v2__chip') : null;
  if (!chip) return;
  setTimeout(nosetteLeChipsEtapa1, 0);
}, true);

document.addEventListener('click', function (e) {
  var btn = e.target.closest ? e.target.closest('.quote-v2__form .quote-v2__submit') : null;
  if (!btn || btn.type === 'submit' || btn.disabled) return; // só o "Próximo" (type=button); "Enviar" tratado na seção 5
  nosetteLeChipsEtapa1(); // snapshot final da etapa 1 antes de ela desmontar
  window.dataLayer.push({
    event: 'form_step',
    form_identifier: NOSETTE_RD_FUNIL_IDENTIFICADOR_FORM,
    form_step_number: 1,
    form_step_total: 2
  });
}, true);

/* ─────────────────────────────────────────────────────────────────────
   4. cta_click — dois caminhos:
      (a) qualquer elemento com data-cta="<id>" [data-cta-location opcional]
          — usar quando o Vitor quiser instrumentar um botão novo no HTML;
      (b) fallback por classe CSS — os CTAs que já existem no export Next.js
          não têm data-cta, então mapeamos as classes conhecidas aqui. Assim
          cta_click passa a disparar em TODAS as páginas sem editar HTML.
          Se um dia esses botões ganharem data-cta próprio, o caminho (a)
          vence (checado primeiro) e não há push duplo.
   ───────────────────────────────────────────────────────────────────── */
var NOSETTE_CTA_CLASSES = {
  'hero-v2__hero-cta':      { id: 'hero_conheca_projetos',   location: 'hero' },
  'hero-v2__cta':           { id: 'header_comecar_projeto',   location: 'header' },
  'about-v2__cta':          { id: 'about_comece_projeto',     location: 'quem_somos' },
  'projects-v2__cta':       { id: 'portfolio_ver_mais',       location: 'portfolio' },
  'specialties-v3__cta':    { id: 'especialidades_conheca',   location: 'especialidades' },
  'mobile-sticky-cta__btn': { id: 'sticky_comecar_projeto',   location: 'mobile_sticky' }
};

document.addEventListener('click', function (e) {
  if (!e.target.closest) return;

  // (a) data-cta explícito tem prioridade
  var elData = e.target.closest('[data-cta]');
  if (elData) {
    window.dataLayer.push({
      event: 'cta_click',
      cta_id: elData.getAttribute('data-cta'),
      cta_text: (elData.textContent || '').trim().slice(0, 80),
      cta_location: elData.getAttribute('data-cta-location') || ''
    });
    return;
  }

  // (b) fallback por classe CSS conhecida
  for (var cls in NOSETTE_CTA_CLASSES) {
    var elCls = e.target.closest('.' + cls);
    if (elCls) {
      var map = NOSETTE_CTA_CLASSES[cls];
      window.dataLayer.push({
        event: 'cta_click',
        cta_id: map.id,
        cta_text: (elCls.textContent || '').trim().slice(0, 80),
        cta_location: map.location
      });
      return;
    }
  }
});

/* ─────────────────────────────────────────────────────────────────────
   5. FORM DE ORÇAMENTO — captura dos dados da etapa 1 (chips) + etapa 2
      (inputs) e envio real ao RD Station no submit.
      ⚠️ VER NOTA NO TOPO DO ARQUIVO — remover esta seção se o Vitor portar
      o envio pra dentro do componente React.
   ───────────────────────────────────────────────────────────────────── */
(function () {
  function coletaInput(form, name) {
    var el = form.querySelector('.quote-v2__input[name="' + name + '"]');
    return el ? (el.value || '').trim() : '';
  }

  // Dedup: o submit chega 2x (evento nativo + re-disparo do React). Guarda a
  // assinatura do último envio e ignora repetição dentro de 4s.
  var nosetteUltimoSubmit = { sig: '', ts: 0 };

  document.addEventListener('submit', function (e) {
    var form = e.target.closest ? e.target.closest('.quote-v2__form') : null;
    if (!form) return;
    // Não chama e.preventDefault() aqui — o handler inline do React já faz isso.
    // Esse listener roda em paralelo (addEventListener não sobrescreve o onSubmit React).

    var nome = coletaInput(form, 'nome');
    var email = coletaInput(form, 'email');
    var telefone = coletaInput(form, 'telefone');
    var metragem = coletaInput(form, 'metragem');

    if (!nome || !email || !telefone) {
      console.warn('[Nosette][form] submit sem nome/email/telefone preenchidos — lead não enviado.');
      return;
    }

    var agora = Date.now();
    var sig = (email + '|' + telefone + '|' + metragem).toLowerCase();
    if (sig === nosetteUltimoSubmit.sig && (agora - nosetteUltimoSubmit.ts) < 4000) {
      return; // envio duplicado do mesmo lead — ignora
    }
    nosetteUltimoSubmit = { sig: sig, ts: agora };

    // Etapa 1 já foi desmontada nesse ponto — usa o snapshot feito na seção 3.
    nosetteLeChipsEtapa1(); // no-op se a etapa 1 não estiver mais no DOM; mantém o último valor
    var tipoProjeto = NOSETTE_STEP1.tipo_projeto;
    var tipoServico = NOSETTE_STEP1.servico_de_interesse;
    var urgencia = NOSETTE_STEP1.urgencia;

    var eventId = nosetteEventId();
    var lead = {
      nome: nome, email: email, telefone: telefone, metragem: metragem,
      tipo_projeto: tipoProjeto, servico_de_interesse: tipoServico, urgencia: urgencia,
      _eventId: eventId
    };

    var btn = form.querySelector('button[type="submit"]');
    var btnTextoOriginal = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }

    nosetteEnviaRd(Object.assign({
      token_rdstation: NOSETTE_RD_TOKEN,
      identificador: NOSETTE_RD_FUNIL_IDENTIFICADOR_FORM,
      email: email,
      nome: nome,
      mobile_phone: nosetteNormalizePhoneMeta(telefone),
      // Campos Nosette-namespaced — NUNCA reusar cf_tipo_de_projeto / cf_servico_de_interesse
      // (esses são do Lan4Films/audiovisual; cf_tipo_de_projeto é RADIO com opções de
      // filme, rejeita "Residencial"/"Comercial"). O RD Marketing auto-cria estes 4
      // como texto livre na 1ª conversão. Mapeamento p/ campos estruturados do RD CRM
      // (Nosette - Tipo de projeto (arquitetura) etc.) é feito no workflow do RD Mkt.
      cf_nosette_tipo_de_projeto: tipoProjeto,
      cf_nosette_tipo_de_servico: tipoServico,
      cf_nosette_urgencia_da_obra: urgencia,
      cf_nosette_metragem_do_projeto: metragem
    }, nosetteUtmPayload()))
    .then(function (r) {
      return r.json().then(function (data) {
        console.log('[Nosette][RD Station] status:', r.status, 'response:', data);
        if (!r.ok) throw new Error(r.status + ' – ' + JSON.stringify(data));
        nosettePushLead(NOSETTE_RD_FUNIL_IDENTIFICADOR_FORM, lead);
        // Feedback de sucesso — genérico até o Vitor definir o design final da confirmação.
        var msgExistente = form.querySelector('.nosette-form-msg');
        if (msgExistente) msgExistente.remove();
        var msg = document.createElement('div');
        msg.className = 'nosette-form-msg';
        msg.style.cssText = 'margin-top:14px;padding:12px;border-radius:8px;background:rgba(0,150,80,.12);color:#0a7a44;font-size:14px;';
        msg.textContent = 'Recebemos seu pedido de orçamento! Em breve entraremos em contato.';
        form.appendChild(msg);
      });
    })
    .catch(function (err) {
      console.error('[Nosette][RD Station] erro:', err);
      var msgExistente = form.querySelector('.nosette-form-msg');
      if (msgExistente) msgExistente.remove();
      var msg = document.createElement('div');
      msg.className = 'nosette-form-msg';
      msg.style.cssText = 'margin-top:14px;padding:12px;border-radius:8px;background:rgba(200,40,40,.12);color:#c02828;font-size:14px;';
      msg.textContent = 'Ocorreu um erro ao enviar. Tente novamente ou fale pelo WhatsApp.';
      form.appendChild(msg);
    })
    .finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = btnTextoOriginal; }
    });
  }, true);
})();

/* ─────────────────────────────────────────────────────────────────────
   6. WHATSAPP — modal de captura (nome/e-mail/telefone + tempo do projeto
      + metragem) antes de abrir o wa.me, com envio de lead ao RD Station —
      replica o padrão LAN4 (main.js linhas ~1301-1406). Intercepta cliques
      em qualquer link cujo href contenha "wa.me".
      Visual alinhado ao form de orçamento (quote-v2): paleta vinho #63182a
      sobre creme #ffeee1, títulos Familjen Grotesk, corpo General Sans.
   ───────────────────────────────────────────────────────────────────── */
var NOSETTE_TEMPO_PROJETO_OPCOES = ['0-2 meses', '2-4 meses', '4-6 meses', '6-8 meses', '8-12 meses', '+1 ano', '+2 anos'];

(function () {
  (function () {
    var M = '#nosette-whatsapp-modal-overlay';
    var FONT_TITULO = 'var(--font-familjen-grotesk), "General Sans", var(--font-montserrat), sans-serif';
    var FONT_CORPO = '"General Sans", var(--font-montserrat), sans-serif';
    var style = document.createElement('style');
    style.textContent = ''
      + M + '{position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;padding:16px;'
      +   'background:rgba(33,8,14,.55);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);opacity:0;transition:opacity .25s ease;}'
      + M + '.is-open{opacity:1;}'
      + M + ' *{box-sizing:border-box;max-width:100%;}'
      + M + ' .nw-box{position:relative;width:100%;max-width:440px;max-height:calc(100vh - 32px);overflow-y:auto;'
      +   'background:#ffeee1;color:#111;border-radius:20px;padding:36px 32px 28px;font-family:' + FONT_CORPO + ';'
      +   'box-shadow:0 30px 80px rgba(33,8,14,.35);transform:translateY(16px);transition:transform .3s ease;}'
      + M + '.is-open .nw-box{transform:none;}'
      + M + ' .nw-fechar{position:absolute;top:14px;right:14px;width:36px;height:36px;border:none;background:transparent;'
      +   'color:#63182a;font-size:22px;line-height:1;cursor:pointer;border-radius:999px;transition:background .2s;}'
      + M + ' .nw-fechar:hover{background:rgba(99,24,42,.08);}'
      + M + ' .nw-eyebrow{font-size:11px;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:#63182a;margin:0 0 10px;}'
      + M + ' .nw-titulo{font-family:' + FONT_TITULO + ';font-size:28px;font-weight:600;line-height:1.15;color:#63182a;margin:0 0 8px;}'
      + M + ' .nw-sub{font-size:14px;line-height:1.5;color:rgba(17,17,17,.65);margin:0 0 24px;}'
      + M + ' .nw-campo{display:block;margin-bottom:18px;}'
      + M + ' .nw-label{display:block;font-size:12px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;color:#63182a;margin-bottom:4px;}'
      + M + ' .nw-label small{text-transform:none;letter-spacing:0;color:rgba(17,17,17,.45);font-weight:400;}'
      + M + ' .nw-input{width:100%;font-family:' + FONT_CORPO + ';font-size:16px;color:#111;background:transparent;border:none;'
      +   'border-bottom:1px solid rgba(99,24,42,.25);border-radius:0;padding:10px 2px;transition:border-color .25s;}'
      + M + ' .nw-input:focus{outline:none;border-bottom-color:#63182a;}'
      + M + ' .nw-input::placeholder{color:rgba(17,17,17,.35);}'
      + M + ' .nw-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}'
      + M + ' .nw-chip{font-family:' + FONT_CORPO + ';font-size:13px;font-weight:500;color:#63182a;background:transparent;'
      +   'border:1px solid rgba(99,24,42,.3);border-radius:999px;padding:8px 14px;cursor:pointer;transition:background .2s,color .2s,border-color .2s;}'
      + M + ' .nw-chip:hover{border-color:#63182a;}'
      + M + ' .nw-chip.is-active{background:#63182a;border-color:#63182a;color:#fff;}'
      + M + ' .nw-erro{color:#b3261e;font-size:12px;min-height:16px;margin:0 0 12px;}'
      + M + ' .nw-enviar{width:100%;display:flex;align-items:center;justify-content:center;gap:10px;padding:16px 24px;'
      +   'font-family:' + FONT_CORPO + ';font-size:13px;font-weight:500;letter-spacing:.03em;text-transform:uppercase;'
      +   'color:#fff;background:#63182a;border:none;border-radius:999px;cursor:pointer;transition:opacity .25s;}'
      + M + ' .nw-enviar:hover{opacity:.9;}'
      + M + ' .nw-enviar:disabled{opacity:.6;cursor:default;}'
      + M + ' .nw-enviar svg{width:18px;height:18px;flex:none;}'
      + M + ' .nw-privacidade{font-size:11px;color:rgba(17,17,17,.45);text-align:center;margin:12px 0 0;}'
      + '@media (max-width:480px){' + M + ' .nw-box{padding:32px 22px 22px;border-radius:18px;}' + M + ' .nw-titulo{font-size:24px;}}'
      /* Delay do botão flutuante (ver bloco 7). Classe própria + !important pra
         não brigar com as regras de visibilidade que o React já aplica. */
      + 'html:not(.nosette-wa-liberado) .whatsapp-float{opacity:0 !important;visibility:hidden !important;pointer-events:none !important;}';
    document.head.appendChild(style);
  })();

  function nosetteWhatsappLink(mensagemBase) {
    var utms = nosetteGetUtms();
    var msg = mensagemBase || NOSETTE_WHATSAPP_MSG_PADRAO;
    if (utms.utm_source) msg += ' (origem: ' + utms.utm_source + ')';
    return 'https://wa.me/' + NOSETTE_WHATSAPP_NUMERO + '?text=' + encodeURIComponent(msg);
  }

  function nosetteWhatsappMensagem(tempo, metragem) {
    var msg = NOSETTE_WHATSAPP_MSG_PADRAO;
    if (tempo) msg += ' Tempo do projeto: ' + tempo + '.';
    if (metragem) msg += ' Metragem: ' + metragem + '.';
    return msg;
  }

  /* whatsapp_click = intenção de contato (abriu o modal / seguiu pro wa.me).
     Alimenta GA4 whatsapp_click + Meta Pixel Contact (sem PII). Dispara em
     TODO caminho (sucesso ou falha do RD) — a intenção aconteceu. */
  function nosetteWhatsappPushEvento() {
    window.dataLayer.push({
      event: 'whatsapp_click',
      cta_location: 'modal',
      event_id: nosetteEventId()
    });
  }

  var ICONE_WHATSAPP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.47 14.38c-.3-.15-1.75-.86-2.02-.96-.27-.1-.47-.15-.67.15-.2.3-.77.96-.94 1.16-.17.2-.35.22-.64.07-.3-.15-1.25-.46-2.38-1.47-.88-.79-1.47-1.76-1.65-2.06-.17-.3-.02-.46.13-.6.13-.14.3-.35.44-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.21 3.08c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.22 1.36.19 1.87.12.57-.09 1.75-.72 2-1.41.25-.69.25-1.29.17-1.41-.07-.12-.27-.2-.57-.35zM12.04 21.5h-.01a9.43 9.43 0 0 1-4.8-1.32l-.35-.2-3.57.93.95-3.48-.22-.36a9.4 9.4 0 0 1-1.44-5.02c0-5.2 4.24-9.44 9.45-9.44a9.38 9.38 0 0 1 9.44 9.45c0 5.21-4.24 9.44-9.45 9.44zm8.04-17.48A11.3 11.3 0 0 0 12.04.7C5.77.7.67 5.8.67 12.06c0 2 .52 3.96 1.52 5.68L.57 23.7l6.1-1.6a11.33 11.33 0 0 0 5.37 1.37h.01c6.26 0 11.36-5.1 11.37-11.37 0-3.03-1.18-5.89-3.34-8.04z"/></svg>';

  function nosetteCriaModalWhatsapp(hrefOriginal) {
    if (document.getElementById('nosette-whatsapp-modal-overlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'nosette-whatsapp-modal-overlay';

    var chipsHtml = NOSETTE_TEMPO_PROJETO_OPCOES.map(function (op) {
      return '<button type="button" class="nw-chip" data-valor="' + op + '">' + op + '</button>';
    }).join('');

    var box = document.createElement('div');
    box.className = 'nw-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'nosette-whatsapp-titulo');
    box.innerHTML =
      '<button type="button" class="nw-fechar" id="nosette-whatsapp-cancelar" aria-label="Fechar">&times;</button>'
      + '<p class="nw-eyebrow">Atendimento via WhatsApp</p>'
      + '<h3 class="nw-titulo" id="nosette-whatsapp-titulo">Vamos conversar sobre o seu projeto</h3>'
      + '<p class="nw-sub">Conte um pouco sobre você e o projeto — assim já chegamos à conversa preparados.</p>'
      + '<div id="nosette-whatsapp-form">'
      + '  <label class="nw-campo"><span class="nw-label">Nome</span>'
      + '    <input class="nw-input" name="nome" autocomplete="name" placeholder="Seu nome completo" required></label>'
      + '  <label class="nw-campo"><span class="nw-label">E-mail</span>'
      + '    <input class="nw-input" name="email" type="email" autocomplete="email" placeholder="seu@email.com" required></label>'
      + '  <label class="nw-campo"><span class="nw-label">WhatsApp</span>'
      + '    <input class="nw-input" name="telefone" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="(11) 99876-5432" required></label>'
      + '  <div class="nw-campo"><span class="nw-label">Tempo do projeto</span>'
      + '    <div class="nw-chips" role="radiogroup" aria-label="Tempo do projeto">' + chipsHtml + '</div></div>'
      + '  <label class="nw-campo"><span class="nw-label">Metragem</span>'
      + '    <input class="nw-input" name="metragem" type="text" placeholder="Ex: 120m²" required></label>'
      + '  <p class="nw-erro" id="nosette-whatsapp-erro" role="alert"></p>'
      + '  <button type="button" class="nw-enviar" id="nosette-whatsapp-enviar">' + ICONE_WHATSAPP + '<span>Continuar no WhatsApp</span></button>'
      + '  <p class="nw-privacidade">Seus dados ficam só com a Nosette.</p>'
      + '</div>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('is-open'); });

    var erroEl = box.querySelector('#nosette-whatsapp-erro');
    var enviarBtn = box.querySelector('#nosette-whatsapp-enviar');
    var enviarTxt = enviarBtn.querySelector('span');
    var cancelarBtn = box.querySelector('#nosette-whatsapp-cancelar');
    var nomeInput = box.querySelector('[name="nome"]');
    var emailInput = box.querySelector('[name="email"]');
    var telInput = box.querySelector('[name="telefone"]');
    var metragemInput = box.querySelector('[name="metragem"]');
    var tempoSelecionado = '';

    box.querySelectorAll('.nw-chip').forEach(function (chip) {
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', 'false');
      chip.addEventListener('click', function () {
        tempoSelecionado = chip.getAttribute('data-valor');
        box.querySelectorAll('.nw-chip').forEach(function (c) {
          var ativo = c === chip;
          c.classList.toggle('is-active', ativo);
          c.setAttribute('aria-checked', ativo ? 'true' : 'false');
        });
      });
    });

    setTimeout(function () { nomeInput.focus(); }, 50);

    function escFecha(e) { if (e.key === 'Escape') fecha(); }
    function fecha() {
      document.removeEventListener('keydown', escFecha);
      overlay.remove();
    }

    cancelarBtn.addEventListener('click', fecha);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) fecha(); });
    document.addEventListener('keydown', escFecha);

    enviarBtn.addEventListener('click', function () {
      var nome = (nomeInput.value || '').trim();
      var email = (emailInput.value || '').trim();
      var telefone = (telInput.value || '').trim();
      var metragem = (metragemInput.value || '').trim();
      var tempo = tempoSelecionado;

      if (!nome || !email || !telefone || !metragem) {
        erroEl.textContent = 'Preencha nome, e-mail, WhatsApp e metragem pra continuar.';
        return;
      }
      if (!nosettePhoneDigits(telefone)) {
        erroEl.textContent = 'Telefone inválido. Digite DDD + celular (ex.: 11998765432).';
        return;
      }
      if (!tempo) {
        erroEl.textContent = 'Selecione o tempo do projeto.';
        return;
      }
      erroEl.textContent = '';
      enviarBtn.disabled = true;
      enviarTxt.textContent = 'Enviando…';

      var eventId = nosetteEventId();
      var lead = { nome: nome, email: email, telefone: telefone, urgencia: tempo, metragem: metragem, _eventId: eventId };
      var mensagem = nosetteWhatsappMensagem(tempo, metragem);

      nosetteEnviaRd(Object.assign({
        token_rdstation: NOSETTE_RD_TOKEN,
        identificador: NOSETTE_RD_FUNIL_IDENTIFICADOR_WHATSAPP,
        email: email,
        nome: nome,
        mobile_phone: nosetteNormalizePhoneMeta(telefone),
        // Mesmos campos Nosette do form de orçamento (ver seção 5).
        cf_nosette_urgencia_da_obra: tempo,
        cf_nosette_metragem_do_projeto: metragem
      }, nosetteUtmPayload()))
      .then(function (r) {
        return r.json().then(function (data) {
          console.log('[Nosette][RD Station][whatsapp] status:', r.status, 'response:', data);
          if (!r.ok) throw new Error(r.status + ' – ' + JSON.stringify(data));
          // Lead de WhatsApp confirmado no RD: evento PRÓPRIO (não 'lead_form_submit').
          // No GTM 'whatsapp_lead_submit' dispara GA4 whatsapp_lead + GAds
          // "Botão de WhatsApp" + Meta Contact (com advanced matching via user_data).
          nosettePushLead(NOSETTE_RD_FUNIL_IDENTIFICADOR_WHATSAPP, lead, 'whatsapp_lead_submit');
          nosetteWhatsappPushEvento();          // + whatsapp_click (intenção)
          fecha();
          window.open(nosetteWhatsappLink(mensagem), '_blank', 'noopener');
        });
      })
      .catch(function (err) {
        console.error('[Nosette][RD Station][whatsapp] erro:', err);
        // RD falhou — NÃO prender o usuário. Ainda assim registramos o
        // whatsapp_click (a intenção de contato aconteceu) e abrimos o wa.me.
        // O whatsapp_lead_submit (com PII pro Meta Contact / GAds "Botão de
        // WhatsApp") fica só no caminho de sucesso — sem confirmação do RD
        // não temos garantia do lead.
        nosetteWhatsappPushEvento();
        fecha();
        window.open(nosetteWhatsappLink(mensagem), '_blank', 'noopener');
      });
    });
  }

  document.addEventListener('click', function (e) {
    var link = e.target.closest ? e.target.closest('a[href*="wa.me"]') : null;
    if (!link) return;
    e.preventDefault();
    nosetteCriaModalWhatsapp(link.getAttribute('href'));
  }, true);
})();

/* ─────────────────────────────────────────────────────────────────────
   7. DELAY DO BOTÃO FLUTUANTE DO WHATSAPP — .whatsapp-float só aparece
      depois de 60s de navegação. O tempo conta a partir da 1ª página da
      sessão (sessionStorage), então trocar de página não reinicia o relógio.
      O CSS que esconde o botão está no <style> do bloco 6.
   ───────────────────────────────────────────────────────────────────── */
(function () {
  var DELAY_MS = 60000;
  var KEY = 'nosette_wa_inicio';
  var inicio = Date.now();
  try {
    var salvo = parseInt(sessionStorage.getItem(KEY), 10);
    if (salvo && salvo <= inicio) inicio = salvo;
    else sessionStorage.setItem(KEY, String(inicio));
  } catch (e) {}
  var restante = Math.max(0, DELAY_MS - (Date.now() - inicio));
  setTimeout(function () {
    document.documentElement.classList.add('nosette-wa-liberado');
  }, restante);
})();
