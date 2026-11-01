document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.product-card').forEach((card) => {
    card.dataset.ready = 'true';
  });
});
