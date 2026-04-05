document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('loginform');
  if (!form) return;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    window.location.href = 'home.html';
  });
});
