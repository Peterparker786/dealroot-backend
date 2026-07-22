require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const app = express();
const PORT = process.env.PORT || 5000;
const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
const jwtSecret = process.env.JWT_SECRET;

if (
  !process.env.MONGODB_URI ||
  !jwtSecret ||
  !process.env.ADMIN_EMAIL ||
  !process.env.ADMIN_PASSWORD_HASH
) {
  throw new Error(
    "Missing MONGODB_URI, JWT_SECRET, ADMIN_EMAIL, or ADMIN_PASSWORD_HASH environment variable"
  );
}

app.set("trust proxy", 1);
app.use(helmet());
app.use(
  cors({
    origin: clientUrl,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  })
);
app.use(express.json({ limit: "100kb" }));

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many login attempts. Please try again after 15 minutes.",
  },
});

const allowedCategories = [
  "Skincare",
  "Makeup",
  "Haircare",
  "Fragrance",
  "Bath & Body",
];

const orderStatuses = [
  "placed",
  "confirmed",
  "packed",
  "shipped",
  "delivered",
  "cancelled",
];

const productSchema = new mongoose.Schema(
  {
    brand: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    category: {
      type: String,
      required: true,
      enum: allowedCategories,
    },
    price: { type: Number, required: true, min: 0 },
    mrp: { type: Number, required: true, min: 0 },
    rating: { type: Number, default: 4.5, min: 0, max: 5 },
    reviews: { type: Number, default: 0, min: 0 },
    image: { type: String, default: "" },
    badge: { type: String, default: "" },
    stock: { type: Number, default: 20, min: 0 },
    isFeatured: { type: Boolean, default: false },
    marketplaceLinks: [
      {
        platform: { type: String, trim: true },
        url: { type: String, trim: true },
      },
    ],
  },
  { timestamps: true }
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    customer: {
      name: { type: String, required: true, trim: true },
      phone: { type: String, required: true, trim: true },
      address: { type: String, required: true, trim: true },
      city: { type: String, required: true, trim: true },
      pincode: { type: String, required: true, trim: true },
    },
    items: [
      {
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
          required: true,
        },
        brand: { type: String, default: "" },
        title: { type: String, required: true },
        image: { type: String, default: "" },
        price: { type: Number, required: true, min: 0 },
        quantity: { type: Number, required: true, min: 1 },
        subtotal: { type: Number, required: true, min: 0 },
      },
    ],
    deliveryFee: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    deliveryType: {
      type: String,
      enum: ["local", "courier"],
      default: "courier",
    },
    paymentMethod: {
      type: String,
      enum: ["cod", "razorpay"],
      default: "cod",
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded"],
      default: "pending",
    },
    orderStatus: {
      type: String,
      enum: orderStatuses,
      default: "placed",
    },
    stockRestored: { type: Boolean, default: false },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const Product = mongoose.model("Product", productSchema);
const Order = mongoose.model("Order", orderSchema);

const requireAdmin = (req, res, next) => {
  const token = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : "";

  try {
    const payload = jwt.verify(token, jwtSecret);

    if (payload.role !== "admin") {
      throw new Error("Invalid role");
    }

    req.admin = payload;
    next();
  } catch {
    res.status(401).json({
      success: false,
      message: "Please log in as an admin.",
    });
  }
};

const sanitizeMarketplaceLinks = (links) => {
  if (!Array.isArray(links)) return [];

  return links
    .map((link) => ({
      platform: String(link?.platform || "").trim(),
      url: String(link?.url || "").trim(),
    }))
    .filter(({ platform, url }) => platform && /^https:\/\//i.test(url))
    .slice(0, 3);
};

const validateProduct = ({ brand, title, category, price, mrp }) => {
  if (!brand || !title || !category || price === "" || mrp === "") {
    return "Brand, title, category, price and MRP are required";
  }

  if (!allowedCategories.includes(category)) {
    return "Please choose a valid category";
  }

  if (
    !Number.isFinite(Number(price)) ||
    !Number.isFinite(Number(mrp)) ||
    Number(price) < 0 ||
    Number(mrp) < 0
  ) {
    return "Price and MRP must be valid positive numbers";
  }

  if (Number(mrp) < Number(price)) {
    return "MRP cannot be lower than selling price";
  }

  return null;
};

const productPayload = (body) => ({
  ...body,
  price: Number(body.price),
  mrp: Number(body.mrp),
  rating: Number(body.rating || 4.5),
  reviews: Number(body.reviews || 0),
  stock: Number(body.stock || 0),
  isFeatured: Boolean(body.isFeatured),
  marketplaceLinks: sanitizeMarketplaceLinks(body.marketplaceLinks),
});

const createOrderNumber = () =>
  `DR-${Date.now()}-${crypto.randomInt(1000, 10000)}`;

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "DEALROOT backend is running",
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "dealroot-backend",
    database:
      mongoose.connection.readyState === 1 ? "connected" : "not connected",
  });
});

app.post("/api/admin/login", adminLoginLimiter, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  const normaliseForComparison = (value) =>
    Buffer.from(String(value).slice(0, 256).padEnd(256));

  const isCorrectEmail = crypto.timingSafeEqual(
    normaliseForComparison(email),
    normaliseForComparison(
      String(process.env.ADMIN_EMAIL).toLowerCase()
    )
  );

  const isCorrectPassword = await bcrypt.compare(
    password,
    process.env.ADMIN_PASSWORD_HASH
  );

  if (!isCorrectEmail || !isCorrectPassword) {
    return res.status(401).json({
      success: false,
      message: "Invalid email or password",
    });
  }

  const token = jwt.sign(
    { role: "admin", email },
    jwtSecret,
    { expiresIn: "8h" }
  );

  res.json({
    success: true,
    token,
    admin: { email },
  });
});

app.get("/api/products", async (req, res) => {
  try {
    const { category, search, featured } = req.query;
    const filter = {};

    if (category && category !== "All") {
      filter.category = category;
    }

    if (featured === "true") {
      filter.isFeatured = true;
    }

    if (search) {
      filter.$or = ["title", "brand", "category"].map((key) => ({
        [key]: {
          $regex: String(search),
          $options: "i",
        },
      }));
    }

    const products = await Product.find(filter).sort({ createdAt: -1 });

    res.json({
      success: true,
      count: products.length,
      products,
    });
  } catch {
    res.status(500).json({
      success: false,
      message: "Could not load products",
    });
  }
});

app.get("/api/products/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.json({ success: true, product });
  } catch {
    res.status(400).json({
      success: false,
      message: "Invalid product id",
    });
  }
});

app.post("/api/products", requireAdmin, async (req, res) => {
  try {
    const error = validateProduct(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: error,
      });
    }

    const product = await Product.create(productPayload(req.body));

    res.status(201).json({
      success: true,
      message: "Product added successfully",
      product,
    });
  } catch {
    res.status(500).json({
      success: false,
      message: "Could not add product",
    });
  }
});

app.put("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const error = validateProduct(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: error,
      });
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      productPayload(req.body),
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.json({
      success: true,
      message: "Product updated successfully",
      product,
    });
  } catch {
    res.status(400).json({
      success: false,
      message: "Could not update product",
    });
  }
});

app.patch("/api/products/:id/stock", requireAdmin, async (req, res) => {
  try {
    const stock = Number(req.body.stock);

    if (!Number.isInteger(stock) || stock < 0) {
      return res.status(400).json({
        success: false,
        message: "Stock must be a whole positive number",
      });
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { stock },
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.json({
      success: true,
      message: "Stock updated successfully",
      product,
    });
  } catch {
    res.status(400).json({
      success: false,
      message: "Could not update stock",
    });
  }
});

app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.json({
      success: true,
      message: "Product deleted successfully",
    });
  } catch {
    res.status(400).json({
      success: false,
      message: "Could not delete product",
    });
  }
});

app.post("/api/orders", async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { customer, items, deliveryType, paymentMethod } = req.body;

    const cleanCustomer = {
      name: String(customer?.name || "").trim(),
      phone: String(customer?.phone || "").replace(/\D/g, ""),
      address: String(customer?.address || "").trim(),
      city: String(customer?.city || "").trim(),
      pincode: String(customer?.pincode || "").replace(/\D/g, ""),
    };

    if (
      !cleanCustomer.name ||
      !cleanCustomer.address ||
      !cleanCustomer.city ||
      cleanCustomer.phone.length !== 10 ||
      cleanCustomer.pincode.length !== 6
    ) {
      throw new Error("Please enter valid delivery details");
    }

    if (!Array.isArray(items) || !items.length) {
      throw new Error("Your cart is empty");
    }

    if (paymentMethod && paymentMethod !== "cod") {
      throw new Error(
        "Online payment is not available yet. Please choose Cash on Delivery."
      );
    }

    let order;

    await session.withTransaction(async () => {
      const orderItems = [];
      let subtotal = 0;

      for (const item of items) {
        const productId = item?.productId;
        const quantity = Number(item?.quantity);

        if (
          !mongoose.Types.ObjectId.isValid(productId) ||
          !Number.isInteger(quantity) ||
          quantity < 1
        ) {
          throw new Error("Invalid product or quantity in cart");
        }

        const product = await Product.findOneAndUpdate(
          {
            _id: productId,
            stock: { $gte: quantity },
          },
          { $inc: { stock: -quantity } },
          { new: true, session }
        );

        if (!product) {
          throw new Error(
            "A product is unavailable or does not have enough stock"
          );
        }

        const lineTotal = product.price * quantity;
        subtotal += lineTotal;

        orderItems.push({
          product: product._id,
          brand: product.brand,
          title: product.title,
          image: product.image,
          price: product.price,
          quantity,
          subtotal: lineTotal,
        });
      }

      const deliveryFee = subtotal >= 499 ? 0 : 49;

      [order] = await Order.create(
        [
          {
            orderNumber: createOrderNumber(),
            customer: cleanCustomer,
            items: orderItems,
            deliveryFee,
            totalAmount: subtotal + deliveryFee,
            deliveryType:
              deliveryType === "local" ? "local" : "courier",
            paymentMethod: "cod",
          },
        ],
        { session }
      );
    });

    res.status(201).json({
      success: true,
      message: "Your order has been placed successfully",
      order,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || "Could not place your order",
    });
  } finally {
    await session.endSession();
  }
});

app.get("/api/orders", requireAdmin, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });

    res.json({
      success: true,
      count: orders.length,
      orders,
    });
  } catch {
    res.status(500).json({
      success: false,
      message: "Could not load orders",
    });
  }
});

app.patch("/api/orders/:id/status", requireAdmin, async (req, res) => {
  try {
    const { orderStatus } = req.body;

    if (!orderStatuses.includes(orderStatus)) {
      return res.status(400).json({
        success: false,
        message: "Please choose a valid order status",
      });
    }

    if (orderStatus === "cancelled") {
      return res.status(400).json({
        success: false,
        message: "Use the cancel order action instead",
      });
    }

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { orderStatus },
      { new: true, runValidators: true }
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    res.json({
      success: true,
      message: "Order status updated successfully",
      order,
    });
  } catch {
    res.status(400).json({
      success: false,
      message: "Could not update order status",
    });
  }
});

app.post("/api/orders/:id/cancel", requireAdmin, async (req, res) => {
  const session = await mongoose.startSession();

  try {
    let order;

    await session.withTransaction(async () => {
      order = await Order.findOne({ _id: req.params.id }).session(session);

      if (!order) {
        throw new Error("Order not found");
      }

      if (order.orderStatus === "cancelled") {
        throw new Error("This order has already been cancelled");
      }

      if (["shipped", "delivered"].includes(order.orderStatus)) {
        throw new Error(
          "A shipped or delivered order cannot be cancelled from admin"
        );
      }

      for (const item of order.items) {
        await Product.findByIdAndUpdate(
          item.product,
          { $inc: { stock: item.quantity } },
          { session }
        );
      }

      order.orderStatus = "cancelled";
      order.stockRestored = true;
      order.cancelledAt = new Date();

      await order.save({ session });
    });

    res.json({
      success: true,
      message: "Order cancelled and stock restored",
      order,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || "Could not cancel order",
    });
  } finally {
    await session.endSession();
  }
});

const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("MongoDB connected");

    app.listen(PORT, () => {
      console.log(`DEALROOT backend running on ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
};

startServer();