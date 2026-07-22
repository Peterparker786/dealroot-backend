require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:5173",
  })
);
app.use(express.json());

const allowedCategories = [
  "Skincare",
  "Makeup",
  "Haircare",
  "Fragrance",
  "Bath & Body",
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
totalAmount: { type: Number, required: true, min: 0 },
    deliveryType: {
      type: String,
      enum: ["local", "courier"],
      default: "courier",
    },
    paymentMethod: {
      type: String,
      enum: ["cod"],
      default: "cod",
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed"],
      default: "pending",
    },
    orderStatus: {
      type: String,
      enum: ["placed", "confirmed", "packed", "shipped", "delivered", "cancelled"],
      default: "placed",
    },
  },
  { timestamps: true }
);

const Product = mongoose.model("Product", productSchema);
const Order = mongoose.model("Order", orderSchema);

const sanitizeMarketplaceLinks = (links) => {
  if (!Array.isArray(links)) return [];

  return links
    .map((link) => ({
      platform: String(link?.platform || "").trim(),
      url: String(link?.url || "").trim(),
    }))
    .filter(({ platform, url }) => platform && url)
    .slice(0, 3);
};

const starterProducts = [
  {
    brand: "Minimalist",
    title: "2% Hyaluronic Acid Face Serum",
    description: "Hydrating serum for soft and healthy-looking skin.",
    category: "Skincare",
    price: 399,
    mrp: 599,
    rating: 4.7,
    reviews: 1840,
    image:
      "https://images.unsplash.com/photo-1620916566398-39f1143ab7be?auto=format&fit=crop&w=700&q=85",
    badge: "Bestseller",
    stock: 30,
    isFeatured: true,
  },
  {
    brand: "Maybelline",
    title: "Fit Me Matte + Poreless Foundation",
    description: "Lightweight matte foundation with a natural finish.",
    category: "Makeup",
    price: 499,
    mrp: 649,
    rating: 4.6,
    reviews: 2300,
    image:
      "https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?auto=format&fit=crop&w=700&q=85",
    badge: "Top deal",
    stock: 25,
    isFeatured: true,
  },
];

const validateProduct = (product) => {
  const { brand, title, category, price, mrp } = product;

  if (!brand || !title || !category || price === "" || mrp === "") {
    return "Brand, title, category, price and MRP are required";
  }

  if (!allowedCategories.includes(category)) {
    return "Please choose a valid category";
  }

  if (Number(price) < 0 || Number(mrp) < 0) {
    return "Price and MRP cannot be negative";
  }

  if (Number(mrp) < Number(price)) {
    return "MRP cannot be lower than selling price";
  }

  return null;
};

const createOrderNumber = () => {
  const randomPart = Math.floor(1000 + Math.random() * 9000);
  return `DR-${Date.now()}-${randomPart}`;
};

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

app.get("/api/products", async (req, res) => {
  try {
    const { category, search, featured } = req.query;
    const filter = {};

    if (category && category !== "All") filter.category = category;
    if (featured === "true") filter.isFeatured = true;

    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: "i" } },
        { brand: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
      ];
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

app.post("/api/products", async (req, res) => {
  try {
    const validationError = validateProduct(req.body);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const deliveryFee = totalAmount >= 499 ? 0 : 49;
totalAmount += deliveryFee;
const product = await Product.create({
      ...req.body,
      price: Number(req.body.price),
      mrp: Number(req.body.mrp),
      rating: Number(req.body.rating || 4.5),
      reviews: Number(req.body.reviews || 0),
      stock: Number(req.body.stock || 0),
      isFeatured: Boolean(req.body.isFeatured),
      marketplaceLinks: sanitizeMarketplaceLinks(req.body.marketplaceLinks),
    });

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

app.put("/api/products/:id", async (req, res) => {
  try {
    const validationError = validateProduct(req.body);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      {
        ...req.body,
        price: Number(req.body.price),
        mrp: Number(req.body.mrp),
        rating: Number(req.body.rating || 4.5),
        reviews: Number(req.body.reviews || 0),
        stock: Number(req.body.stock || 0),
        isFeatured: Boolean(req.body.isFeatured),
        marketplaceLinks: sanitizeMarketplaceLinks(req.body.marketplaceLinks),
      },
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

app.patch("/api/products/:id/stock", async (req, res) => {
  try {
    const stock = Number(req.body.stock);

    if (!Number.isFinite(stock) || stock < 0) {
      return res.status(400).json({
        success: false,
        message: "Stock must be a valid positive number",
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

/* ───────────── ORDERS / CHECKOUT ───────────── */

app.post("/api/orders", async (req, res) => {
  const reducedProducts = [];

  try {
    const { customer, items, deliveryType, paymentMethod } = req.body;

    const name = String(customer?.name || "").trim();
    const phone = String(customer?.phone || "").replace(/\D/g, "");
    const address = String(customer?.address || "").trim();
    const city = String(customer?.city || "").trim();
    const pincode = String(customer?.pincode || "").replace(/\D/g, "");

    if (!name || !address || !city || phone.length !== 10 || pincode.length !== 6) {
      return res.status(400).json({
        success: false,
        message: "Please enter valid delivery details",
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Your cart is empty",
      });
    }

    if (paymentMethod && paymentMethod !== "cod") {
      return res.status(400).json({
        success: false,
        message: "Online payment is not available yet. Please choose Cash on Delivery.",
      });
    }

    const orderItems = [];
    let totalAmount = 0;

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

      // Stock is reduced only if enough stock is available.
      const product = await Product.findOneAndUpdate(
        { _id: productId, stock: { $gte: quantity } },
        { $inc: { stock: -quantity } },
        { new: true }
      );

      if (!product) {
        const existingProduct = await Product.findById(productId);

        if (!existingProduct) {
          throw new Error("One of the products is no longer available");
        }

        throw new Error(`${existingProduct.title} does not have enough stock`);
      }

      reducedProducts.push({ productId, quantity });

      const subtotal = product.price * quantity;
      totalAmount += subtotal;

      orderItems.push({
        product: product._id,
        brand: product.brand,
        title: product.title,
        image: product.image,
        price: product.price,
        quantity,
        subtotal,
      });
    }

    const order = await Order.create({
      orderNumber: createOrderNumber(),
      customer: {
        name,
        phone,
        address,
        city,
        pincode,
      },
      items: orderItems,
      deliveryFee,
      totalAmount,
      deliveryType: deliveryType === "local" ? "local" : "courier",
      paymentMethod: "cod",
      paymentStatus: "pending",
      orderStatus: "placed",
    });

    res.status(201).json({
      success: true,
      message: "Your order has been placed successfully",
      order,
    });
  } catch (error) {
    // If order creation fails after stock was reduced, restore the stock.
    for (const item of reducedProducts) {
      await Product.findByIdAndUpdate(item.productId, {
        $inc: { stock: item.quantity },
      });
    }

    res.status(400).json({
      success: false,
      message: error.message || "Could not place your order",
    });
  }
});

app.get("/api/orders", async (req, res) => {
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

app.patch("/api/orders/:id/status", async (req, res) => {
  try {
    const allowedStatuses = [
      "placed",
      "confirmed",
      "packed",
      "shipped",
      "delivered",
      "cancelled",
    ];

    const { orderStatus } = req.body;

    if (!allowedStatuses.includes(orderStatus)) {
      return res.status(400).json({
        success: false,
        message: "Please choose a valid order status",
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

app.delete("/api/products/:id", async (req, res) => {
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

const seedProducts = async () => {
  const count = await Product.countDocuments();

  if (count === 0) {
    await Product.insertMany(starterProducts);
    console.log("Starter products added to MongoDB");
  }
};

const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("MongoDB connected");

    await seedProducts();

    app.listen(PORT, () => {
      console.log(`DEALROOT backend running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
};

startServer();