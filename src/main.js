

document.getElementById('loginform').addEventListener('submit', function(event) {
  event.preventDefault();

  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  if (username === "user" && password === "password") {
    alert("Login successful");
    window.location.replace("home.html");
  } else {
    alert("Login failed");
  }


});