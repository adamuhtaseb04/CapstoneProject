document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("loginform");
  const message = document.getElementById("login-message");

  if (localStorage.getItem("token") && window.location.pathname.includes("index")) {
    window.location.href = "home.html";
    return;
  }

  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const username = document.getElementById("username")?.value.trim();
    const password = document.getElementById("password")?.value.trim();

    if (!username || !password) {
      if (message) {
        message.style.color = "#fb7185";
        message.textContent = "Please enter both username and password.";
      }
      return;
    }

    try {
      let response = await fetch("http://localhost:3000/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ username, password })
      });

      if (response.status === 401) {
        response = await fetch("http://localhost:3000/register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ username, password })
        });
      }

      const data = await response.json();

      if (!response.ok) {
        if (message) {
          message.style.color = "#fb7185";
          message.textContent = data.message || "Authentication failed.";
        }
        return;
      }

      localStorage.setItem("token", data.token);
      localStorage.setItem("currentUser", JSON.stringify(data.user));

      if (message) {
        message.style.color = "#34d399";
        message.textContent = data.message || "Success.";
      }

      setTimeout(() => {
        window.location.href = "home.html";
      }, 700);
    } catch {
      if (message) {
        message.style.color = "#fb7185";
        message.textContent = "Unable to connect to the server.";
      }
    }
  });
});