import { httpRouter } from "convex/server";
import { verify, message } from "./whatsapp";

const http = httpRouter();

http.route({
    path: "/webhook",
    method: "GET",
    handler: verify,
});

http.route({
    path: "/webhook",
    method: "POST",
    handler: message,
});

export default http;
