/**
 * Os números do hero saem do banco, não do HTML.
 *
 * Número cravado em landing page envelhece calado e vira mentira na
 * primeira atualização — e esta página existe justamente para dizer que o
 * projeto mede o que afirma.
 */
const N = (v) => Number(v || 0).toLocaleString("pt-BR");

const CAMPOS = [
  ["cartas", "Cartas no catálogo", "EN · JA · KO · ZH · PT"],
  ["hashes", "Reconhecíveis pela câmera", "índice local, sem rede"],
  ["cartas_preco", "Com preço", "por variante e mercado"],
  ["cotacoes", "Cotações", "cada uma com fonte e data"],
];

(async () => {
  const alvo = document.getElementById("numeros");
  let d;
  try {
    d = await fetch("data/numeros.json").then((r) => r.json());
  } catch {
    alvo.closest("section").remove();   // sem dado, sem seção: nada de zeros
    return;
  }
  alvo.innerHTML = CAMPOS.map(([chave, rotulo, nota]) =>
    `<div class="kpi"><small>${rotulo}</small><b>${N(d[chave])}</b>
      <em>${nota}</em></div>`).join("");
})();
