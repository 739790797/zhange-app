export type RouteLoadTicket = {
  revision: number;
  route: string;
};

export function createRouteLoadGuard() {
  let revision = 0;
  const isCurrent = (ticket: RouteLoadTicket, route: string) =>
    ticket.revision === revision && ticket.route === route;

  return {
    begin(route: string): RouteLoadTicket {
      revision += 1;
      return { revision, route };
    },
    isCurrent(ticket: RouteLoadTicket, route: string) {
      return isCurrent(ticket, route);
    },
    async load<T>(
      ticket: RouteLoadTicket,
      currentRoute: () => string,
      importer: () => Promise<T>,
      install: (module: T) => void,
      fail: () => void,
    ) {
      try {
        const module = await importer();
        if (!isCurrent(ticket, currentRoute())) return false;
        install(module);
        return true;
      } catch {
        if (isCurrent(ticket, currentRoute())) fail();
        return false;
      }
    },
  };
}
